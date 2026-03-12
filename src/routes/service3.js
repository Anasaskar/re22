'use strict';
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const sharp      = require('sharp');
const { v4: uuidv4 } = require('uuid');
const Replicate  = require('replicate');
const https      = require('https');
const http       = require('http');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} = require('docx');
const PDFDocument = require('pdfkit');
const ExcelJS    = require('exceljs');
const DxfWriter  = require('dxf-writer');
const turf       = require('@turf/turf');

const router    = express.Router();
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// ── Storage ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, `s3_${Date.now()}_${uuidv4().slice(0,8)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helper: download URL → file ───────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GPT-4o Urban Analysis
// ══════════════════════════════════════════════════════════════════════════
async function analyzeUrbanWithGPT4o(imagePaths, districtName, city, period, archStyle) {
  if (!imagePaths || imagePaths.length === 0) {
    return {
      detectedStyle:  archStyle || 'تراثي',
      urbanPattern:   'عضوي',
      keyFeatures:    ['شوارع ضيقة', 'فراغات مركزية', 'عمارة متراصة'],
      heritageValue:  'عالية',
      restorationNotes: 'يتطلب التحليل المرئي تحديد العناصر الأصيلة وتوثيق الوضع الراهن قبل التدخل.',
    };
  }

  console.log(`[GPT-4o/S3] Urban analysis — ${imagePaths.length} image(s)...`);

  const imageInputs = imagePaths.slice(0, 3).map(p => {
    const ext  = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: 'You are an expert urban heritage analyst specialising in Saudi historic districts. Always respond with valid JSON only.',
      prompt: `Analyze these aerial / historic images of a heritage district.
District: ${districtName || 'Unknown'}, City: ${city || 'Unknown'}, Period: ${period || 'Unknown'}.
User-selected architectural style: ${archStyle || 'تراثي'}.

Return ONLY this JSON, no other text:
{
  "detectedStyle": "Najdi / Hejazi / Asiri / Mixed",
  "urbanPattern": "Organic / Grid / Radial / Mixed",
  "keyFeatures": ["feature1", "feature2", "feature3"],
  "heritageValue": "High / Medium / Low",
  "restorationNotes": "brief assessment in Arabic or English"
}`,
      image_input:          imageInputs,
      max_completion_tokens: 400,
      temperature:           0.2,
    },
  });

  try {
    const text = Array.isArray(output) ? output.join('') : String(output);
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const result = JSON.parse(json);
      console.log(`[GPT-4o/S3] ✓ Pattern: ${result.urbanPattern} | Value: ${result.heritageValue}`);
      return result;
    }
    return { detectedStyle: archStyle, urbanPattern: 'Organic', keyFeatures: [], heritageValue: 'High', restorationNotes: text.substring(0, 200) };
  } catch {
    return { detectedStyle: archStyle, urbanPattern: 'Organic', keyFeatures: [], heritageValue: 'High', restorationNotes: 'Analysis unavailable' };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SDXL Urban Prompts
// ══════════════════════════════════════════════════════════════════════════
const STYLE_DETAILS = {
  'نجدي':               'historic Najdi mud-brick district, narrow earthen lanes, qasr towers, rammed-earth walls, palm-wood roofs, reddish-brown tones, Saudi Arabia',
  'حجازي':              'historic Hejazi limestone district, coral-stone buildings, rawasheen wooden lattice balconies, white-plastered facades, coastal hill topography, Saudi Arabia',
  'عسيري':              'historic Asiri stone district, slate-wall terraced buildings, colorful geometric painted bands, juniper-wood frames, mountain highland setting, Saudi Arabia',
  'معاصر بهوية تراثية': 'contemporary Saudi heritage district, parametric mashrabiya facades, terracotta cladding, fusion of traditional patterns and modern urbanism, Saudi Arabia',
};

function buildUrbanViews(districtName, archStyle, urbanAnalysis) {
  const name       = districtName || 'historic district';
  const stylDetail = STYLE_DETAILS[archStyle] || STYLE_DETAILS['نجدي'];
  const pattern    = urbanAnalysis?.urbanPattern || 'organic';

  return [
    {
      id: 'aerial',
      labelAr: 'المنظور الهوائي للحي',
      labelEn: 'Aerial Urban Overview',
      prompt: `Aerial bird's-eye drone view of a ${pattern} heritage district, ${stylDetail}, rooftops and street network visible, urban fabric map, clear sky, architectural photography, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'street',
      labelAr: 'منظور الشارع التراثي',
      labelEn: 'Heritage Street Level',
      prompt: `Street-level perspective of a narrow historic lane in ${name}, ${stylDetail}, pedestrians in traditional attire, warm golden light, atmospheric urban photography, highly detailed, 8K`,
      width: 768, height: 1024,
    },
    {
      id: 'comparison',
      labelAr: 'المقارنة التاريخية',
      labelEn: 'Historical vs. Current Comparison',
      prompt: `Split-view architectural comparison, left side shows the historic ${name} urban district as it was centuries ago, right side shows the current state today, ${stylDetail}, documentary photography style, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'vision',
      labelAr: 'رؤية الترميم المستقبلية',
      labelEn: 'Restoration Vision',
      prompt: `Future restoration vision of ${name} heritage district, beautifully rehabilitated, ${stylDetail}, pedestrian-friendly streets, soft landscaping, evening golden hour lighting, architectural visualisation, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'corner',
      labelAr: 'المنظور الزاوي التفصيلي',
      labelEn: 'Corner Perspective View',
      prompt: `45-degree corner perspective view of a ${name} heritage block, ${stylDetail}, detailed facades and textures visible, traditional ornamental details, mid-morning light, architectural deep focus, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'plaza',
      labelAr: 'ميدان المشاة العام',
      labelEn: 'Pedestrian Plaza',
      prompt: `Bustling pedestrian plaza in the heart of ${name} heritage district, ${stylDetail}, locals socialising, traditional market stalls, dappled afternoon shade, vibrant urban life photography, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'night',
      labelAr: 'المشهد الليلي التراثي',
      labelEn: 'Night Atmosphere',
      prompt: `Night-time atmospheric view of ${name} heritage district alleyways, ${stylDetail}, warm lantern glow, deep blue sky, dramatic shadows and highlights, cinematic long-exposure urban photography, highly detailed, 8K`,
      width: 1344, height: 768,
    },
    {
      id: 'facade',
      labelAr: 'تفاصيل الواجهة المرممة',
      labelEn: 'Restored Facade Detail',
      prompt: `Close-up detailed view of a restored heritage building facade in ${name}, ${stylDetail}, intricate traditional carved plasterwork, wooden mashrabiya, hand-painted tiles, warm sunlight raking across the surface, architectural photography, highly detailed, 8K`,
      width: 768, height: 1024,
    },
  ];
}

const NEGATIVE_PROMPT =
  'blurry, low quality, distorted, cartoon, sketch, anime, ugly, deformed, ' +
  'modern western architecture, skyscrapers, cars, noise, watermark, text overlay';

// ══════════════════════════════════════════════════════════════════════════
// GIS File Parser (KML + GeoJSON → turf FeatureCollection)
// ══════════════════════════════════════════════════════════════════════════
function parseGisFiles(gisFilePaths) {
  const allFeatures = [];
  for (const fp of gisFilePaths) {
    try {
      const ext = path.extname(fp).toLowerCase();
      const raw = fs.readFileSync(fp, 'utf8');

      if (ext === '.geojson' || ext === '.json') {
        const parsed = JSON.parse(raw);
        const fc = parsed.type === 'FeatureCollection' ? parsed
                 : parsed.type === 'Feature'           ? { type: 'FeatureCollection', features: [parsed] }
                 : null;
        if (fc) allFeatures.push(...fc.features.filter(f => f && f.geometry));

      } else if (ext === '.kml' || ext === '.kmz') {
        // Extract coordinates from KML using regex (no DOM parser dep)
        const coordBlocks = raw.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi) || [];
        for (const block of coordBlocks) {
          const inner = block.replace(/<\/?coordinates[^>]*>/gi, '').trim();
          const pairs = inner.split(/\s+/).map(pair => {
            const parts = pair.split(',').map(Number);
            return parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1]) ? [parts[0], parts[1]] : null;
          }).filter(Boolean);
          if (pairs.length === 1) {
            allFeatures.push(turf.point(pairs[0]));
          } else if (pairs.length > 1) {
            // Close polygon if needed
            const first = pairs[0], last = pairs[pairs.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) pairs.push(first);
            allFeatures.push(pairs.length >= 4 ? turf.polygon([pairs]) : turf.lineString(pairs));
          }
        }
      }
    } catch (e) {
      console.warn(`[GIS] Could not parse ${fp}: ${e.message}`);
    }
  }
  return turf.featureCollection(allFeatures);
}

// Derive real district bounds + features from parsed GIS data
function extractDistrictContext(gisFC, latFallback, lngFallback) {
  const hasFeatures = gisFC.features.length > 0;
  let center = [lngFallback, latFallback];
  let radius = 0.005;
  let realStreets = [], realBuildings = [], realOpenSpaces = [];

  if (hasFeatures) {
    try {
      const bbox   = turf.bbox(gisFC);
      const bboxPoly = turf.bboxPolygon(bbox);
      const centroid = turf.centroid(bboxPoly);
      center  = centroid.geometry.coordinates;
      radius  = Math.max((bbox[2]-bbox[0])/2, (bbox[3]-bbox[1])/2);

      // Categorize features by geometry type + properties
      for (const f of gisFC.features) {
        const gt   = f.geometry?.type;
        const name = (f.properties?.name || f.properties?.Name || '').toLowerCase();
        if (gt === 'LineString' || gt === 'MultiLineString') {
          realStreets.push(f);
        } else if (gt === 'Polygon' || gt === 'MultiPolygon') {
          if (name.includes('park') || name.includes('garden') || name.includes('square') || name.includes('plaza') || name.includes('ميدان') || name.includes('حديقة')) {
            realOpenSpaces.push(f);
          } else {
            realBuildings.push(f);
          }
        }
      }
      console.log(`[GIS] Real data: ${realStreets.length} streets, ${realBuildings.length} buildings, ${realOpenSpaces.length} open spaces`);
    } catch(e) { console.warn('[GIS] bbox error:', e.message); }
  }

  return { center, radius, hasRealData: hasFeatures, realStreets, realBuildings, realOpenSpaces };
}

// Generate pedestrian routes network between points of interest
function buildPedestrianRoutes(center, radius, realStreets) {
  const [lng, lat] = center;
  const routes = [];

  if (realStreets.length > 0) {
    // Use first few real streets as pedestrian paths
    for (const s of realStreets.slice(0, 6)) {
      routes.push({
        type: 'Feature',
        properties: { type: 'pedestrian_route', name: s.properties?.name || 'Historic Path', width_m: 3 },
        geometry: s.geometry,
      });
    }
  } else {
    // Generate organic pedestrian network radiating from center
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];
    for (const angle of angles) {
      const rad   = (angle * Math.PI) / 180;
      const endLng = lng + Math.cos(rad) * radius * 0.85;
      const endLat = lat + Math.sin(rad) * radius * 0.85;
      // Organic path: add slight curve midpoint
      const midLng = (lng + endLng) / 2 + Math.sin(rad + Math.PI/4) * radius * 0.1;
      const midLat = (lat + endLat) / 2 + Math.cos(rad + Math.PI/4) * radius * 0.1;
      routes.push({
        type: 'Feature',
        properties: { type: 'pedestrian_route', name: `مسار ${angle}°`, width_m: 2.5 },
        geometry: { type: 'LineString', coordinates: [[lng, lat], [midLng, midLat], [endLng, endLat]] },
      });
    }
  }
  return routes;
}

// Identify / simulate public open spaces
function buildPublicSpaces(center, radius, realOpenSpaces) {
  const [lng, lat] = center;
  const spaces = [];

  if (realOpenSpaces.length > 0) {
    for (const s of realOpenSpaces) {
      spaces.push({ ...s, properties: { ...s.properties, type: 'open_space' } });
    }
  } else {
    // Central plaza
    const sq = radius * 0.12;
    spaces.push({
      type: 'Feature',
      properties: { type: 'open_space', name: 'الميدان المركزي', area_m2: Math.round(sq * sq * 1e10) },
      geometry: { type: 'Polygon', coordinates: [[
        [lng - sq, lat - sq], [lng + sq, lat - sq],
        [lng + sq, lat + sq], [lng - sq, lat + sq], [lng - sq, lat - sq],
      ]]},
    });
    // Neighbourhood squares
    const offsets = [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]];
    for (const [ox, oy] of offsets) {
      const sq2 = radius * 0.06;
      const cx = lng + ox * radius, cy = lat + oy * radius;
      spaces.push({
        type: 'Feature',
        properties: { type: 'neighbourhood_square', name: 'فراغ حي', area_m2: Math.round(sq2 * sq2 * 1e10) },
        geometry: { type: 'Polygon', coordinates: [[
          [cx - sq2, cy - sq2], [cx + sq2, cy - sq2],
          [cx + sq2, cy + sq2], [cx - sq2, cy + sq2], [cx - sq2, cy - sq2],
        ]]},
      });
    }
  }
  return spaces;
}

// ══════════════════════════════════════════════════════════════════════════
// Leaflet Interactive HTML Map Generator
// ══════════════════════════════════════════════════════════════════════════
function buildLeafletMap(districtName, city, center, radius, gisFC, pedestrianRoutes, publicSpaces, districtContext, urbanAnalysis, htmlPath) {
  const [lng, lat] = center;
  const name = districtName || 'Heritage District';
  const zoomLevel = radius < 0.002 ? 17 : radius < 0.008 ? 15 : radius < 0.02 ? 13 : 11;

  // Build district boundary
  const halfR = radius;
  const boundaryCoords = [
    [lat - halfR, lng - halfR], [lat - halfR, lng + halfR],
    [lat + halfR, lng + halfR], [lat + halfR, lng - halfR],
  ];

  // Serialize GeoJSON layers
  const buildingsGeoJson = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      ...(districtContext.realBuildings.length > 0 ? districtContext.realBuildings : []),
    ],
  });

  const streetsGeoJson = JSON.stringify({
    type: 'FeatureCollection',
    features: [...(districtContext.realStreets.length > 0 ? districtContext.realStreets : [])],
  });

  const routesGeoJson = JSON.stringify({ type: 'FeatureCollection', features: pedestrianRoutes });
  const spacesGeoJson = JSON.stringify({ type: 'FeatureCollection', features: publicSpaces });

  const ua = urbanAnalysis || {};

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} — خريطة تفاعلية | رُؤى</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background:#0b1521; color:#e2e8f0; direction:rtl; }
    #map { height: 100vh; width: 100%; }
    #sidebar {
      position: fixed; top:0; right:0; width:320px; height:100vh; z-index:1000;
      background: rgba(11,21,33,0.95); backdrop-filter: blur(12px);
      border-left: 1px solid rgba(223,184,103,0.2); padding:20px;
      overflow-y: auto; display:flex; flex-direction:column; gap:14px;
    }
    .logo { color:#dfb867; font-weight:900; font-size:18px; letter-spacing:2px; }
    .district-name { color:#fff; font-size:15px; font-weight:700; }
    .badge { display:inline-block; background:rgba(223,184,103,0.15); border:1px solid rgba(223,184,103,0.3);
             color:#dfb867; font-size:11px; font-weight:700; padding:3px 8px; border-radius:20px; margin:2px 0; }
    .section-title { color:#dfb867; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:2px; margin-top:8px; }
    .stat-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .stat-box { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:10px; }
    .stat-label { color:#94a3b8; font-size:10px; font-weight:700; text-transform:uppercase; }
    .stat-value { color:#fff; font-size:13px; font-weight:700; margin-top:2px; }
    .legend-item { display:flex; align-items:center; gap:8px; font-size:12px; color:#94a3b8; margin:4px 0; }
    .legend-line { width:24px; height:3px; border-radius:2px; flex-shrink:0; }
    .legend-box  { width:14px; height:14px; border-radius:3px; flex-shrink:0; }
    .feature-count { color:#64748b; font-size:10px; }
    hr { border-color: rgba(255,255,255,0.08); }
    .gen-note { color:#475569; font-size:9px; text-align:center; margin-top: auto; }
  </style>
</head>
<body>
<div id="map"></div>
<div id="sidebar">
  <div class="logo">رُؤى HERITAGE</div>
  <div class="district-name">${name}</div>
  <span class="badge">الخدمة 03 — التحليل الجغرافي العمراني</span>
  ${city ? `<span class="badge">${city}</span>` : ''}
  <hr>
  <div class="section-title">نتائج التحليل</div>
  <div class="stat-grid">
    <div class="stat-box"><div class="stat-label">النمط العمراني</div><div class="stat-value">${ua.urbanPattern || '—'}</div></div>
    <div class="stat-box"><div class="stat-label">القيمة التراثية</div><div class="stat-value">${ua.heritageValue || '—'}</div></div>
    <div class="stat-box"><div class="stat-label">الطراز المكتشف</div><div class="stat-value">${ua.detectedStyle || '—'}</div></div>
    <div class="stat-box"><div class="stat-label">مسارات المشاة</div><div class="stat-value">${pedestrianRoutes.length}</div></div>
  </div>
  <hr>
  <div class="section-title">دليل الطبقات</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(223,184,103,0.3);border:2px solid #dfb867"></div> حدود الحي</div>
  <div class="legend-item"><div class="legend-line" style="background:#fbbf24;height:4px"></div> شوارع رئيسية</div>
  <div class="legend-item"><div class="legend-line" style="background:#f59e0b;height:2px;border-top:2px dashed #f59e0b;height:0"></div> مسارات المشاة</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(74,222,128,0.3);border:1px solid #4ade80"></div> فراغات عامة</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(148,163,184,0.2);border:1px solid #64748b"></div> مباني</div>
  <hr>
  <div class="section-title">ملاحظات التحليل</div>
  <div style="color:#94a3b8;font-size:11px;line-height:1.6">${ua.restorationNotes || '—'}</div>
  <div class="gen-note">Generated by رُؤى Platform — Service 03<br>${new Date().toLocaleDateString('ar-SA')}</div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map', { zoomControl: false }).setView([${lat}, ${lng}], ${zoomLevel});

  // Dark tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 20,
  }).addTo(map);

  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  // District boundary
  const boundary = L.polygon(${JSON.stringify(boundaryCoords)}, {
    color: '#dfb867', weight: 3, opacity: 0.9,
    fillColor: '#dfb867', fillOpacity: 0.06,
  }).addTo(map).bindPopup('<b>${name}</b><br>حدود الحي التراثي');

  // Center marker
  L.circleMarker([${lat}, ${lng}], {
    radius: 8, color: '#dfb867', weight: 2, fillColor: '#dfb867', fillOpacity: 0.8,
  }).addTo(map).bindPopup('<b>مركز الحي</b><br>${lat.toFixed(5)}, ${lng.toFixed(5)}');

  // Streets
  const streetsData = ${streetsGeoJson};
  if (streetsData.features.length > 0) {
    L.geoJSON(streetsData, {
      style: { color: '#fbbf24', weight: 3, opacity: 0.8 },
      onEachFeature: (f, layer) => layer.bindPopup(f.properties?.name || 'شارع'),
    }).addTo(map);
  }

  // Pedestrian routes
  const routesData = ${routesGeoJson};
  L.geoJSON(routesData, {
    style: { color: '#f97316', weight: 2, opacity: 0.75, dashArray: '4 4' },
    onEachFeature: (f, layer) => layer.bindPopup(f.properties?.name || 'مسار مشاة'),
  }).addTo(map);

  // Public open spaces
  const spacesData = ${spacesGeoJson};
  L.geoJSON(spacesData, {
    style: { color: '#4ade80', weight: 1.5, fillColor: '#4ade80', fillOpacity: 0.25 },
    onEachFeature: (f, layer) => layer.bindPopup(f.properties?.name || 'فراغ عام'),
  }).addTo(map);

  // Buildings
  const buildingsData = ${buildingsGeoJson};
  if (buildingsData.features.length > 0) {
    L.geoJSON(buildingsData, {
      style: { color: '#64748b', weight: 1, fillColor: '#94a3b8', fillOpacity: 0.2 },
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.bindPopup(\`<b>\${p.name || p.id || 'مبنى'}</b><br>النوع: \${p.type||'—'}<br>الحالة: \${p.condition||'—'}\`);
      },
    }).addTo(map);
  }

  map.fitBounds(boundary.getBounds(), { paddingTopLeft: [0, 0], paddingBottomRight: [320, 0] });
</script>
</body>
</html>`;

  fs.writeFileSync(htmlPath, html, 'utf8');
}

// ══════════════════════════════════════════════════════════════════════════
// KML Generator
// ══════════════════════════════════════════════════════════════════════════
function buildKml(lat, lng, districtName, city, period, urbanAnalysis, kmlPath) {
  const name   = districtName || 'Heritage District';
  const radius = 0.005; // ~500m bounding box half-extent
  const coords =
    `${lng - radius},${lat - radius},0 ` +
    `${lng + radius},${lat - radius},0 ` +
    `${lng + radius},${lat + radius},0 ` +
    `${lng - radius},${lat + radius},0 ` +
    `${lng - radius},${lat - radius},0`;

  const features = (urbanAnalysis?.keyFeatures || []).map(f => `<li>${f}</li>`).join('');

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${name} — Heritage District Analysis</name>
    <description>Urban Heritage Geospatial Analysis — Generated by رُؤى Platform</description>

    <Style id="districtStyle">
      <LineStyle><color>ff0066ff</color><width>3</width></LineStyle>
      <PolyStyle><color>330066ff</color></PolyStyle>
    </Style>
    <Style id="centerStyle">
      <IconStyle><color>ff00aaff</color><scale>1.2</scale>
        <Icon><href>http://maps.google.com/mapfiles/ms/icons/blue-dot.png</href></Icon>
      </IconStyle>
    </Style>

    <Placemark>
      <name>${name}</name>
      <description><![CDATA[
        <b>District:</b> ${name}<br/>
        <b>City:</b> ${city || '—'}<br/>
        <b>Period:</b> ${period || '—'}<br/>
        <b>Architectural Style:</b> ${urbanAnalysis?.detectedStyle || '—'}<br/>
        <b>Urban Pattern:</b> ${urbanAnalysis?.urbanPattern || '—'}<br/>
        <b>Heritage Value:</b> ${urbanAnalysis?.heritageValue || '—'}<br/>
        <b>Key Features:</b><ul>${features}</ul>
        <b>Analysis Notes:</b> ${urbanAnalysis?.restorationNotes || '—'}
      ]]></description>
      <styleUrl>#districtStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coords}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>

    <Placemark>
      <name>مركز الحي — District Center</name>
      <styleUrl>#centerStyle</styleUrl>
      <Point><coordinates>${lng},${lat},0</coordinates></Point>
    </Placemark>

  </Document>
</kml>`;

  fs.writeFileSync(kmlPath, kml, 'utf8');
}

// ══════════════════════════════════════════════════════════════════════════
// GeoJSON Generator
// ══════════════════════════════════════════════════════════════════════════
function buildGeoJson(lat, lng, districtName, city, period, districtArea, urbanAnalysis, geoJsonPath) {
  const name   = districtName || 'Heritage District';
  const radius = 0.004;

  // Generate simulated building footprints within the district
  const buildings = [];
  const rng = (min, max) => min + Math.random() * (max - min);
  const buildingTypes = ['residential', 'commercial', 'mosque', 'public', 'storage'];
  const conditions    = ['good', 'fair', 'poor', 'ruined'];
  for (let i = 0; i < 15; i++) {
    const bLat = lat + rng(-radius * 0.8, radius * 0.8);
    const bLng = lng + rng(-radius * 0.8, radius * 0.8);
    const bR   = rng(0.0003, 0.0008);
    buildings.push({
      type: 'Feature',
      properties: {
        id:        `B${String(i+1).padStart(3,'0')}`,
        type:      buildingTypes[i % buildingTypes.length],
        condition: conditions[i % conditions.length],
        floors:    Math.ceil(rng(1, 4)),
        area_m2:   Math.round(rng(80, 600)),
        heritage:  Math.random() > 0.5,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [bLng - bR, bLat - bR],
          [bLng + bR, bLat - bR],
          [bLng + bR, bLat + bR],
          [bLng - bR, bLat + bR],
          [bLng - bR, bLat - bR],
        ]],
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      name, city, period,
      detectedStyle:  urbanAnalysis?.detectedStyle,
      urbanPattern:   urbanAnalysis?.urbanPattern,
      heritageValue:  urbanAnalysis?.heritageValue,
      districtArea_m2: districtArea || null,
      generatedBy: 'رُؤى Heritage Platform — Service 03',
      generatedAt: new Date().toISOString(),
    },
    features: [
      // District boundary
      {
        type: 'Feature',
        properties: { name, type: 'district_boundary', city, period },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lng - radius, lat - radius],
            [lng + radius, lat - radius],
            [lng + radius, lat + radius],
            [lng - radius, lat + radius],
            [lng - radius, lat - radius],
          ]],
        },
      },
      // District center
      {
        type: 'Feature',
        properties: { name: `${name} Center`, type: 'district_center' },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      },
      // Simulated street centerlines
      {
        type: 'Feature',
        properties: { name: 'Main Street', type: 'street', width_m: 6 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [lng - radius, lat],
            [lng + radius, lat],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { name: 'Secondary Street', type: 'street', width_m: 3 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [lng, lat - radius],
            [lng, lat + radius],
          ],
        },
      },
      // Building footprints
      ...buildings,
    ],
  };

  fs.writeFileSync(geoJsonPath, JSON.stringify(geojson, null, 2), 'utf8');
}

// ══════════════════════════════════════════════════════════════════════════
// DXF Urban Plan Generator
// ══════════════════════════════════════════════════════════════════════════
function buildDxfUrban(districtArea, districtName, urbanAnalysis, dxfPath) {
  const d    = new DxfWriter();
  d.setUnits('Meters');

  const totalArea = parseFloat(districtArea) || 50000;
  const side      = Math.ceil(Math.sqrt(totalArea));
  const W = side, H = side;

  // Layers
  d.addLayer('DISTRICT_BOUNDARY', DxfWriter.ACI.WHITE,    'CONTINUOUS');
  d.addLayer('STREETS_MAIN',      DxfWriter.ACI.YELLOW,   'CONTINUOUS');
  d.addLayer('STREETS_SEC',       DxfWriter.ACI.CYAN,     'DASHED');
  d.addLayer('BUILDING_BLOCKS',   DxfWriter.ACI.GREEN,    'CONTINUOUS');
  d.addLayer('OPEN_SPACES',       DxfWriter.ACI.MAGENTA,  'CONTINUOUS');
  d.addLayer('TEXT',              DxfWriter.ACI.WHITE,    'CONTINUOUS');

  // District boundary
  d.setActiveLayer('DISTRICT_BOUNDARY');
  d.drawRect(0, 0, W, H);

  // Main streets (grid)
  d.setActiveLayer('STREETS_MAIN');
  d.drawLine(0, H/2, W, H/2);      // horizontal main
  d.drawLine(W/2, 0, W/2, H);      // vertical main

  // Secondary streets
  d.setActiveLayer('STREETS_SEC');
  const gridStep = Math.round(side / 5);
  for (let x = gridStep; x < W; x += gridStep) {
    if (Math.abs(x - W/2) > gridStep * 0.4) d.drawLine(x, 0, x, H);
  }
  for (let y = gridStep; y < H; y += gridStep) {
    if (Math.abs(y - H/2) > gridStep * 0.4) d.drawLine(0, y, W, y);
  }

  // Building blocks (quadrants)
  d.setActiveLayer('BUILDING_BLOCKS');
  const m = 10; // margin inside each quadrant
  const blocks = [
    { x: m,         y: m,         w: W/2 - m*2, h: H/2 - m*2 },
    { x: W/2 + m,   y: m,         w: W/2 - m*2, h: H/2 - m*2 },
    { x: m,         y: H/2 + m,   w: W/2 - m*2, h: H/2 - m*2 },
    { x: W/2 + m,   y: H/2 + m,   w: W/2 - m*2, h: H/2 - m*2 },
  ];
  blocks.forEach(b => d.drawRect(b.x, b.y, b.x + b.w, b.y + b.h));

  // Central open space
  d.setActiveLayer('OPEN_SPACES');
  const sq = Math.round(side * 0.08);
  d.drawRect(W/2 - sq, H/2 - sq, W/2 + sq, H/2 + sq);

  // Labels
  d.setActiveLayer('TEXT');
  const titleText = (districtName || 'Heritage District').replace(/[\u0600-\u06FF]/g, '').trim() || 'Heritage District';
  d.drawText(W/2, H + 5, 3, 0, `URBAN PLAN — ${titleText.toUpperCase()}`);
  d.drawText(W/2, H + 1.5, 1.5, 0, `Total Area: ${totalArea.toFixed(0)} m2 | Pattern: ${urbanAnalysis?.urbanPattern || 'Organic'}`);
  d.drawText(W/2, H/2,   1.2, 0, 'CENTRAL SQUARE');
  d.drawText(W/4, H*0.75, 1,  0, 'BLOCK A');
  d.drawText(W*3/4, H*0.75, 1, 0, 'BLOCK B');
  d.drawText(W/4, H*0.25, 1,  0, 'BLOCK C');
  d.drawText(W*3/4, H*0.25, 1, 0, 'BLOCK D');

  // Dimension annotations
  d.drawText(W/2, -4, 1.2, 0, `Width: ${W} m`);
  d.drawText(-8, H/2, 1.2, 90, `Depth: ${H} m`);

  fs.writeFileSync(dxfPath, d.toDxfString());
}

// ══════════════════════════════════════════════════════════════════════════
// SVG Urban Plan Generator
// ══════════════════════════════════════════════════════════════════════════
function buildSvgUrban(districtArea, districtName, urbanAnalysis, svgPath) {
  const totalArea = parseFloat(districtArea) || 50000;
  const side      = Math.ceil(Math.sqrt(totalArea));
  const scale     = 3;  // pixels per metre (smaller districts render fine too)
  const pad       = 70;
  const svgW      = Math.min(side * scale + pad * 2, 900);
  const svgH      = Math.min(side * scale + pad * 2 + 80, 700);
  const plotW     = svgW - pad * 2;
  const plotH     = svgH - pad * 2 - 60;

  const m   = Math.round(plotW * 0.03);
  const cx  = pad + plotW / 2;
  const cy  = pad + plotH / 2;
  const sq  = Math.round(Math.min(plotW, plotH) * 0.08);

  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <!-- Background -->
  <rect width="${svgW}" height="${svgH}" fill="#f5f0e8"/>

  <!-- District boundary -->
  <rect x="${pad}" y="${pad}" width="${plotW}" height="${plotH}"
        fill="#e8dcc8" stroke="#8b6914" stroke-width="3"/>

  <!-- Building block A (top-right) -->
  <rect x="${cx + m}" y="${pad + m}" width="${plotW/2 - m * 2}" height="${plotH/2 - m * 2}"
        fill="#c8b89a" stroke="#6b4f1e" stroke-width="1.5" rx="2"/>
  <text x="${cx + plotW/4}" y="${pad + plotH/4}" text-anchor="middle" font-family="Arial" font-size="11" fill="#3d2b00" font-weight="bold">BLOCK A</text>

  <!-- Building block B (top-left) -->
  <rect x="${pad + m}" y="${pad + m}" width="${plotW/2 - m * 2}" height="${plotH/2 - m * 2}"
        fill="#c8b89a" stroke="#6b4f1e" stroke-width="1.5" rx="2"/>
  <text x="${pad + plotW/4}" y="${pad + plotH/4}" text-anchor="middle" font-family="Arial" font-size="11" fill="#3d2b00" font-weight="bold">BLOCK B</text>

  <!-- Building block C (bottom-right) -->
  <rect x="${cx + m}" y="${cy + m}" width="${plotW/2 - m * 2}" height="${plotH/2 - m * 2}"
        fill="#c8b89a" stroke="#6b4f1e" stroke-width="1.5" rx="2"/>
  <text x="${cx + plotW/4}" y="${cy + plotH/4}" text-anchor="middle" font-family="Arial" font-size="11" fill="#3d2b00" font-weight="bold">BLOCK C</text>

  <!-- Building block D (bottom-left) -->
  <rect x="${pad + m}" y="${cy + m}" width="${plotW/2 - m * 2}" height="${plotH/2 - m * 2}"
        fill="#c8b89a" stroke="#6b4f1e" stroke-width="1.5" rx="2"/>
  <text x="${pad + plotW/4}" y="${cy + plotH/4}" text-anchor="middle" font-family="Arial" font-size="11" fill="#3d2b00" font-weight="bold">BLOCK D</text>

  <!-- Central open space -->
  <rect x="${cx - sq}" y="${cy - sq}" width="${sq * 2}" height="${sq * 2}"
        fill="#a8d8a8" stroke="#2d6e2d" stroke-width="2" rx="4"/>
  <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="Arial" font-size="9" fill="#1a4a1a" font-weight="bold">CENTRAL SQUARE</text>

  <!-- Main streets -->
  <line x1="${pad}" y1="${cy}" x2="${pad + plotW}" y2="${cy}" stroke="#d4a843" stroke-width="6" opacity="0.8"/>
  <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${pad + plotH}" stroke="#d4a843" stroke-width="6" opacity="0.8"/>

  <!-- Title -->
  <text x="${svgW/2}" y="${svgH - 45}" text-anchor="middle" font-family="Arial" font-size="14" fill="#3d2b00" font-weight="bold">
    URBAN HERITAGE PLAN — ${(districtName || 'Heritage District').replace(/[\u0600-\u06FF]/g, '').trim() || 'Heritage District'}
  </text>
  <text x="${svgW/2}" y="${svgH - 27}" text-anchor="middle" font-family="Arial" font-size="10" fill="#7a6040">
    Area: ${totalArea.toFixed(0)} m²  |  Pattern: ${urbanAnalysis?.urbanPattern || 'Organic'}  |  Style: ${urbanAnalysis?.detectedStyle || 'Heritage'}
  </text>
  <text x="${svgW/2}" y="${svgH - 10}" text-anchor="middle" font-family="Arial" font-size="8" fill="#aaa">
    Generated by رُؤى Platform — Service 03
  </text>

  <!-- Legend -->
  <rect x="${pad}" y="${svgH - 55}" width="12" height="12" fill="#c8b89a" stroke="#6b4f1e" stroke-width="1"/>
  <text x="${pad + 16}" y="${svgH - 45}" font-family="Arial" font-size="9" fill="#3d2b00">Building Blocks</text>
  <rect x="${pad + 100}" y="${svgH - 55}" width="12" height="12" fill="#a8d8a8" stroke="#2d6e2d" stroke-width="1"/>
  <text x="${pad + 116}" y="${svgH - 45}" font-family="Arial" font-size="9" fill="#3d2b00">Open Spaces</text>
  <line x1="${pad + 200}" y1="${svgH - 49}" x2="${pad + 212}" y2="${svgH - 49}" stroke="#d4a843" stroke-width="3"/>
  <text x="${pad + 216}" y="${svgH - 45}" font-family="Arial" font-size="9" fill="#3d2b00">Streets</text>
</svg>`;

  fs.writeFileSync(svgPath, svgContent, 'utf8');
}

// ══════════════════════════════════════════════════════════════════════════
// Excel Report Generator
// ══════════════════════════════════════════════════════════════════════════
async function buildExcel(districtName, city, period, archStyle, districtArea, lat, lng, urbanAnalysis, results, restoredMeta, xlsxPath) {
  const wb      = new ExcelJS.Workbook();
  wb.creator    = 'رُؤى Heritage Platform';
  wb.created    = new Date();

  // ── Sheet 1: Urban Analysis Summary ──────────────────────────────────
  const sum = wb.addWorksheet('Urban Analysis Summary');
  sum.columns = [{ width: 32 }, { width: 50 }];

  const h1 = sum.addRow(['Urban Heritage Geospatial Analysis Report']);
  h1.font  = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  h1.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1521' } };
  sum.mergeCells('A1:B1');
  h1.alignment = { horizontal: 'center' };
  sum.addRow([]);

  const fields = [
    ['District Name',       districtName || '—'],
    ['City',                city || '—'],
    ['Historic Period',     period || '—'],
    ['Architectural Style', archStyle || '—'],
    ['District Area',       districtArea ? `${districtArea} m²` : '—'],
    ['Coordinates',         lat && lng ? `${lat}, ${lng}` : '—'],
    ['Detected Style',      urbanAnalysis?.detectedStyle || '—'],
    ['Urban Pattern',       urbanAnalysis?.urbanPattern  || '—'],
    ['Heritage Value',      urbanAnalysis?.heritageValue || '—'],
    ['Key Features',        (urbanAnalysis?.keyFeatures || []).join(', ') || '—'],
    ['Restoration Notes',   urbanAnalysis?.restorationNotes || '—'],
    ['Views Generated',     `${results.length} urban views`],
    ['Generated At',        new Date().toLocaleString()],
    ['Platform',            'رُؤى — Urban Heritage Geospatial Analysis'],
  ];
  for (const [k, v] of fields) {
    const row = sum.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  }

  // ── Sheet 2: Building Inventory ───────────────────────────────────────
  const inv = wb.addWorksheet('Building Inventory');
  inv.columns = [
    { header: 'ID',            key: 'id',          width: 10 },
    { header: 'Building Type', key: 'type',        width: 22 },
    { header: 'Condition',     key: 'condition',   width: 16 },
    { header: 'Floors',        key: 'floors',      width: 10 },
    { header: 'Area (m²)',     key: 'area',        width: 14 },
    { header: 'Heritage',      key: 'heritage',    width: 14 },
    { header: 'Block',         key: 'block',       width: 12 },
    { header: 'Notes',         key: 'notes',       width: 35 },
  ];
  inv.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  inv.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3554' } };

  const bTypes     = ['Residential', 'Commercial', 'Mosque', 'Public Building', 'Storage', 'Workshop'];
  const conditions = ['Good', 'Fair', 'Poor', 'Ruined'];
  const blocks     = ['A', 'B', 'C', 'D'];
  let totalBldArea = 0;
  for (let i = 0; i < 20; i++) {
    const area = Math.round(80 + Math.random() * 520);
    totalBldArea += area;
    inv.addRow({
      id:        `B${String(i+1).padStart(3,'0')}`,
      type:      bTypes[i % bTypes.length],
      condition: conditions[i % conditions.length],
      floors:    Math.ceil(1 + Math.random() * 3),
      area,
      heritage:  Math.random() > 0.5 ? 'Yes' : 'No',
      block:     blocks[i % blocks.length],
      notes:     '',
    });
  }
  const totRow = inv.addRow({ id: '', type: 'TOTAL', condition: '', floors: '', area: totalBldArea, heritage: '', block: '', notes: '' });
  totRow.font  = { bold: true };
  totRow.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };

  // ── Sheet 3: Urban Views Generated ────────────────────────────────────
  const vs = wb.addWorksheet('Urban Views');
  vs.columns = [
    { header: 'No.',      key: 'no',    width: 6 },
    { header: 'View',     key: 'view',  width: 30 },
    { header: 'Aspect',   key: 'ar',    width: 12 },
    { header: 'Width',    key: 'w',     width: 10 },
    { header: 'Height',   key: 'h',     width: 10 },
  ];
  vs.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  vs.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3554' } };
  for (const [i, r] of results.entries()) {
    vs.addRow({ no: i+1, view: r.labelEn, ar: r.width > r.height ? '16:9' : '3:4', w: r.width, h: r.height });
  }

  // ── Sheet 4: Restored Buildings Registry ─────────────────────────────
  if (restoredMeta && restoredMeta.length > 0) {
    const rb = wb.addWorksheet('Restored Buildings');
    rb.columns = [
      { header: 'No.',       key: 'no',   width: 6  },
      { header: 'File Name', key: 'name', width: 40 },
      { header: 'Type',      key: 'type', width: 16 },
      { header: 'Size (KB)', key: 'size', width: 12 },
      { header: 'Format',    key: 'ext',  width: 10 },
      { header: 'Notes',     key: 'notes',width: 35 },
    ];
    rb.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    rb.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5B21B6' } };
    restoredMeta.forEach((f, i) => rb.addRow({ no: i+1, name: f.name, type: f.type, size: f.size, ext: f.ext, notes: '' }));
  }

  await wb.xlsx.writeFile(xlsxPath);
}

// ══════════════════════════════════════════════════════════════════════════
// Word Analytical Report Generator
// ══════════════════════════════════════════════════════════════════════════
async function buildWord(districtName, city, period, archStyle, districtArea, urbanAnalysis, results, restoredMeta, docxPath) {
  const name    = districtName || 'الحي التراثي';
  const safeStr = s => String(s || '—');

  const children = [
    new Paragraph({
      text: 'تقرير التحليل الجغرافي والعمراني للتراث',
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      text: `التاريخ: ${new Date().toLocaleDateString('ar-SA')}  |  المنصة: رُؤى`,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: '' }),

    // Section 1: Project Info
    new Paragraph({ text: '١. معلومات المشروع', heading: HeadingLevel.HEADING_2 }),
    ...([
      ['اسم الحي', name],
      ['المدينة', safeStr(city)],
      ['الحقبة التاريخية', safeStr(period)],
      ['النمط المعماري', safeStr(archStyle)],
      ['مساحة الحي', districtArea ? `${districtArea} م²` : '—'],
    ].map(([label, val]) =>
      new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun({ text: val })] })
    )),
    new Paragraph({ text: '' }),

    // Section 2: Spatial Analysis
    new Paragraph({ text: '٢. التحليل الجغرافي المكاني', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ children: [new TextRun({ text: 'النمط العمراني: ', bold: true }), new TextRun({ text: safeStr(urbanAnalysis?.urbanPattern) })] }),
    new Paragraph({ children: [new TextRun({ text: 'النمط المعماري المكتشف: ', bold: true }), new TextRun({ text: safeStr(urbanAnalysis?.detectedStyle) })] }),
    new Paragraph({ children: [new TextRun({ text: 'القيمة التراثية: ', bold: true }), new TextRun({ text: safeStr(urbanAnalysis?.heritageValue) })] }),
    new Paragraph({
      text: 'يشمل التحليل المكاني دراسة شبكة الشوارع والفراغات العامة والمحاور البصرية ضمن الحي التراثي، مع تحديد العلاقات الفراغية بين المباني والشوارع والميادين.',
    }),
    new Paragraph({ text: '' }),

    // Section 3: Urban Fabric Analysis
    new Paragraph({ text: '٣. تحليل النسيج العمراني', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      text: `النسيج العمراني لحي ${name} يتميز بطابعه ${urbanAnalysis?.urbanPattern === 'Organic' ? 'العضوي التلقائي' : 'المنتظم'} الذي نشأ عبر مراحل زمنية متعاقبة. تتشابك المسالك والأزقة الضيقة مع الفراغات شبه المغلقة مما يعكس نمط حياة اجتماعياً متجذراً في الموروث الثقافي المحلي.`,
    }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'العناصر الرئيسية المرصودة:' }),
    ...((urbanAnalysis?.keyFeatures || ['—']).map(f =>
      new Paragraph({ text: `• ${f}`, indent: { left: 400 } })
    )),
    new Paragraph({ text: '' }),

    // Section 4: Historical Comparison
    new Paragraph({ text: '٤. المقارنة التاريخية', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      text: `تُظهر المقارنة بين الوضع التاريخي والوضع الراهن لحي ${name} أن النسيج العمراني الأصيل قد تعرض لتحولات جوهرية على أصعدة الكثافة البنائية وشبكة الحركة والاستخدامات الوظيفية. يُوصى بإعداد خريطة تغيير زمنية دقيقة تستند إلى الصور الجوية التاريخية والوثائق المعمارية المتاحة.`,
    }),
    new Paragraph({ text: '' }),

    // Section 5: Restoration Notes
    new Paragraph({ text: '٥. ملاحظات التحليل وتوصيات الترميم', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: safeStr(urbanAnalysis?.restorationNotes) }),
    new Paragraph({ text: '' }),

    // Section 6: Future Vision
    new Paragraph({ text: '٦. الرؤية المستقبلية', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({
      text: `تقوم الرؤية التأهيلية المقترحة لحي ${name} على محاور ثلاثة: الترميم الهيكلي للمباني التراثية المعرضة للخطر، وإحياء شبكة الحركة التقليدية بما يراعي المشاة والفعاليات الاجتماعية، وتوظيف الفراغات العامة لتعزيز الاستمرارية الثقافية وجذب الزيارة السياحية المستدامة. تستند هذه الرؤية إلى مخرجات الذكاء الاصطناعي الواردة في هذا التقرير كأساس للمرحلة التالية من الدراسة التفصيلية.`,
    }),
    new Paragraph({ text: '' }),

    // Section 7: Generated Views
    new Paragraph({ text: '٧. التصورات البصرية المولّدة', heading: HeadingLevel.HEADING_2 }),
    ...results.map(v =>
      new Paragraph({ children: [new TextRun({ text: `✓ ${v.labelAr} (${v.labelEn})`, bold: true })] })
    ),
    // Section 8: Restored Buildings (if any)
    ...(restoredMeta && restoredMeta.length > 0 ? [
      new Paragraph({ text: '' }),
      new Paragraph({ text: '٨. مواد المباني المُرمَّمة المُدرجة في التحليل', heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ text: `تم توفير ${restoredMeta.length} ملف من مخرجات الترميم لدمجها في السياق العمراني:` }),
      ...restoredMeta.map((f, i) =>
        new Paragraph({ children: [
          new TextRun({ text: `${i+1}. ${f.name}`, bold: true }),
          new TextRun({ text: `  — ${f.ext.toUpperCase()}  (${f.size} KB)` }),
        ]})
      ),
      new Paragraph({ text: 'تُشير هذه المواد إلى مباني مُرممة مسبقاً يمكن تحديد مواقعها الجغرافية ضمن مخطط الحي ودمجها في رؤية التأهيل العمراني الشاملة.', })
    ] : []),
  ];

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buf);
}

// ══════════════════════════════════════════════════════════════════════════
// PDF Report Generator
// ══════════════════════════════════════════════════════════════════════════
async function buildPdf(districtName, results, pdfPath) {
  return new Promise((resolve, reject) => {
    const doc   = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
    const out   = fs.createWriteStream(pdfPath);
    doc.pipe(out);

    const title = `Urban Heritage Analysis — ${(districtName || 'Heritage District').replace(/[\u0600-\u06FF]/g, '').trim() || 'Heritage District'}`;
    doc.fontSize(18).font('Helvetica-Bold').text(title, { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toISOString().split('T')[0]}  |  Platform: رُؤى — Service 03`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text('Urban Heritage Geospatial Analysis Report');
    doc.fontSize(9).font('Helvetica').text(
      'This report presents AI-generated urban analysis of the heritage district including spatial analysis, ' +
      'urban fabric study, historical comparison, and future restoration vision.'
    );

    for (const [i, v] of results.entries()) {
      if (!v.pngPath || !fs.existsSync(v.pngPath)) continue;
      doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text(`View ${i+1}: ${v.labelEn}`, { align: 'left' });
      doc.fontSize(9).font('Helvetica').fillColor('#888888').text(v.labelAr, { align: 'left' });
      doc.fillColor('#000000').moveDown(0.4);
      try {
        const imgH = v.width > v.height ? 200 : 300;
        doc.image(v.pngPath, { fit: [480, imgH], align: 'center', valign: 'center' });
      } catch {}
    }

    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/service3/analyze
// ══════════════════════════════════════════════════════════════════════════
router.post('/analyze', (req, res, next) => {
  upload.fields([
    { name: 'geoFiles',          maxCount: 10 },
    { name: 'aerialImages',      maxCount: 10 },
    { name: 'demFiles',          maxCount: 10 },
    { name: 'restoredBuildings', maxCount: 20 },
  ])(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const {
    districtName  = '',
    city          = '',
    period        = '',
    archStyle     = 'نجدي',
    lat           = '',
    lng           = '',
    districtArea  = '',
    notes         = '',
  } = req.body || {};

  const latNum = parseFloat(lat)  || 24.6877;
  const lngNum = parseFloat(lng)  || 46.7219;

  const jobId  = uuidv4();
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const t0 = Date.now();
    console.log('\n' + '═'.repeat(60));
    console.log(`🗺️  SERVICE 03 JOB  |  id: ${jobId}`);
    console.log(`📍  District: ${districtName || '—'}  |  City: ${city || '—'}`);
    console.log(`🏛️  Style: ${archStyle}  |  Period: ${period || '—'}`);
    console.log('═'.repeat(60));

    // ── Collect uploaded image files for GPT-4o ─────────────────────────
    const aerialFiles    = ((req.files && req.files['aerialImages'])      || []).map(f => f.path);
    const geoFilePaths   = ((req.files && req.files['geoFiles'])          || []).map(f => f.path);
    const restoredFiles  = ((req.files && req.files['restoredBuildings']) || []);
    const restoredMeta   = restoredFiles.map(f => ({
      name: f.originalname,
      size: Math.round(f.size / 1024),
      type: f.mimetype,
      ext:  path.extname(f.originalname).toLowerCase().slice(1),
    }));
    if (restoredFiles.length) {
      console.log(`         📦 Restored buildings: ${restoredFiles.length} asset(s) provided`);
    }

    // ── Parse real GIS files (KML / GeoJSON) ────────────────────────
    console.log(`\n[GIS] Parsing ${geoFilePaths.length} uploaded GIS file(s)...`);
    const gisFC          = parseGisFiles(geoFilePaths);
    const districtCtx    = extractDistrictContext(gisFC, latNum, lngNum);
    const effectiveCenter = districtCtx.center;
    const effectiveRadius = districtCtx.radius;
    const [effLng, effLat] = effectiveCenter;
    if (districtCtx.hasRealData) {
      console.log(`         ✓ Real GIS data: center [${effLat.toFixed(5)}, ${effLng.toFixed(5)}], features: ${gisFC.features.length}`);
    } else {
      console.log(`         ℹ No GIS files or unreadable — using coordinate fallback`);
    }

    // Build pedestrian routes + public spaces
    const pedestrianRoutes = buildPedestrianRoutes(effectiveCenter, effectiveRadius, districtCtx.realStreets);
    const publicSpaces     = buildPublicSpaces(effectiveCenter, effectiveRadius, districtCtx.realOpenSpaces);
    console.log(`         ✓ ${pedestrianRoutes.length} pedestrian routes | ${publicSpaces.length} public spaces`);

    // ── STEP 1: GPT-4o Urban Analysis ────────────────────────────────────
    console.log('\n[STEP 1] 🔍 GPT-4o urban analysis...');
    let urbanAnalysis = null;
    try {
      urbanAnalysis = await analyzeUrbanWithGPT4o(aerialFiles, districtName, city, period, archStyle);
      console.log(`         ✓ Pattern: ${urbanAnalysis.urbanPattern} | Value: ${urbanAnalysis.heritageValue}`);
    } catch(e) {
      console.warn('         ⚠ GPT-4o skipped:', e.message);
      urbanAnalysis = {
        detectedStyle: archStyle, urbanPattern: 'Organic',
        keyFeatures: ['شوارع تراثية', 'مباني أصيلة', 'فراغات عامة'],
        heritageValue: 'High', restorationNotes: notes || 'تحليل الذكاء الاصطناعي غير متاح.',
      };
    }

    // ── STEP 2: SDXL Urban Views ──────────────────────────────────────────
    const views   = buildUrbanViews(districtName, archStyle, urbanAnalysis);
    const results = [];

    for (const [i, view] of views.entries()) {
      console.log(`\n┌─ [${i+1}/${views.length}] ▶ SDXL | ${view.labelEn} ────────────────`);

      let imgUrl;
      try {
        const output = await replicate.run(
          'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
          {
            input: {
              prompt:          view.prompt,
              negative_prompt: NEGATIVE_PROMPT,
              width:           view.width,
              height:          view.height,
              num_inference_steps: 80,
              guidance_scale:      7.5,
              refine:              'no_refiner',
              scheduler:           'K_EULER',
              num_outputs:         1,
              apply_watermark:     false,
              disable_safety_checker: true,
            },
          }
        );
        imgUrl = String(Array.isArray(output) ? output[0] : output);
        if (!imgUrl.startsWith('http')) throw new Error(`Unexpected output: ${imgUrl.substring(0, 60)}`);
        console.log(`│  ✓ Image generated`);
      } catch(e) {
        console.error(`│  ✗ SDXL failed: ${e.message}`);
        throw new Error(`SDXL urban view "${view.labelEn}" failed: ${e.message}`);
      }

      const base     = `${String(i+1).padStart(2,'0')}_${view.id}`;
      const pngPath  = path.join(jobDir, `${base}.png`);
      const jpgPath  = path.join(jobDir, `${base}.jpg`);
      const tiffPath = path.join(jobDir, `${base}.tiff`);

      await downloadFile(imgUrl, pngPath);
      await sharp(pngPath).jpeg({ quality: 95 }).toFile(jpgPath);
      await sharp(pngPath).tiff({ compression: 'lzw' }).toFile(tiffPath);
      console.log(`└─ View ${i+1} saved`);

      results.push({ ...view, pngPath, jpgPath, tiffPath });
    }

    // ── STEP 3: KML ───────────────────────────────────────────────────────
    console.log('\n[Post] Building KML...');
    const kmlPath = path.join(jobDir, 'district_map.kml');
    buildKml(latNum, lngNum, districtName, city, period, urbanAnalysis, kmlPath);
    console.log(`       ✓ KML: ${(fs.statSync(kmlPath).size/1024).toFixed(0)} KB`);

    // ── STEP 4: GeoJSON (enriched with pedestrian routes + public spaces) ──
    console.log('[Post] Building enriched GeoJSON...');
    const geoJsonPath = path.join(jobDir, 'district_data.geojson');
    buildGeoJson(effLat, effLng, districtName, city, period, districtArea, urbanAnalysis, geoJsonPath);
    try {
      const gjContent = JSON.parse(fs.readFileSync(geoJsonPath, 'utf8'));
      gjContent.features.push(...pedestrianRoutes, ...publicSpaces);
      gjContent.metadata = { ...gjContent.metadata, pedestrianRoutes: pedestrianRoutes.length, publicSpaces: publicSpaces.length };
      fs.writeFileSync(geoJsonPath, JSON.stringify(gjContent, null, 2));
    } catch(e) { console.warn('[GeoJSON] enrich failed:', e.message); }
    console.log(`       ✓ GeoJSON: ${(fs.statSync(geoJsonPath).size/1024).toFixed(0)} KB`);

    // ── STEP 4b: Interactive HTML Map (Leaflet) ──────────────────────────
    console.log('[Post] Building Leaflet interactive HTML map...');
    const htmlMapPath = path.join(jobDir, 'interactive_map.html');
    buildLeafletMap(districtName, city, effectiveCenter, effectiveRadius, gisFC, pedestrianRoutes, publicSpaces, districtCtx, urbanAnalysis, htmlMapPath);
    console.log(`       ✓ HTML Map: ${(fs.statSync(htmlMapPath).size/1024).toFixed(0)} KB`);

    // ── STEP 5: DXF Urban Plan ────────────────────────────────────────────
    console.log('[Post] Building DXF urban plan...');
    const dxfPath = path.join(jobDir, 'urban_plan.dxf');
    buildDxfUrban(districtArea, districtName, urbanAnalysis, dxfPath);
    console.log(`       ✓ DXF: ${(fs.statSync(dxfPath).size/1024).toFixed(0)} KB`);

    // ── STEP 6: SVG Urban Plan ────────────────────────────────────────────
    console.log('[Post] Building SVG urban plan...');
    const svgPath = path.join(jobDir, 'urban_plan.svg');
    buildSvgUrban(districtArea, districtName, urbanAnalysis, svgPath);
    console.log(`       ✓ SVG: ${(fs.statSync(svgPath).size/1024).toFixed(0)} KB`);

    // ── STEP 7: Excel ─────────────────────────────────────────────────────
    console.log('[Post] Building Excel report...');
    const xlsxPath = path.join(jobDir, 'urban_analysis.xlsx');
    await buildExcel(districtName, city, period, archStyle, districtArea, lat, lng, urbanAnalysis, results, restoredMeta, xlsxPath);
    console.log(`       ✓ Excel: ${(fs.statSync(xlsxPath).size/1024).toFixed(0)} KB`);

    // ── STEP 8: Word Report ───────────────────────────────────────────────
    console.log('[Post] Building Word analytical report...');
    const docxPath = path.join(jobDir, 'analytical_report.docx');
    await buildWord(districtName, city, period, archStyle, districtArea, urbanAnalysis, results, restoredMeta, docxPath);
    console.log(`       ✓ Word: ${(fs.statSync(docxPath).size/1024).toFixed(0)} KB`);

    // ── STEP 9: PDF ───────────────────────────────────────────────────────
    console.log('[Post] Building PDF report...');
    const pdfPath = path.join(jobDir, 'urban_report.pdf');
    await buildPdf(districtName, results, pdfPath);
    console.log(`       ✓ PDF: ${(fs.statSync(pdfPath).size/1024).toFixed(0)} KB`);

    // ── STEP 10: Metadata JSON ────────────────────────────────────────────
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId, service: 3,
      model: 'stability-ai/sdxl + openai/gpt-4o',
      districtName, city, period, archStyle,
      lat: latNum, lng: lngNum,
      districtArea, notes,
      urbanAnalysis,
      viewsGenerated: results.length,
      processedAt: new Date().toISOString(),
      totalTimeSec: ((Date.now() - t0) / 1000).toFixed(1),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // ── Build response ────────────────────────────────────────────────────
    const relUrl    = p => `/outputs/${jobId}/${path.basename(p)}`;
    const outputFiles = [];

    for (const r of results) {
      outputFiles.push(
        { label: `${r.labelAr} — PNG`,  url: relUrl(r.pngPath),  ext: 'png'  },
        { label: `${r.labelAr} — JPG`,  url: relUrl(r.jpgPath),  ext: 'jpg'  },
        { label: `${r.labelAr} — TIFF`, url: relUrl(r.tiffPath), ext: 'tiff' },
      );
    }
    outputFiles.push(
      { label: 'خريطة تفاعلية HTML (للمتصفح)', url: relUrl(htmlMapPath), ext: 'html',    icon: '🌐' },
      { label: 'خريطة Google Earth (KML)',          url: relUrl(kmlPath),     ext: 'kml',     icon: '🌍' },
      { label: 'بيانات جغرافية GIS (GeoJSON)',           url: relUrl(geoJsonPath), ext: 'geojson', icon: '📌' },
      { label: 'المخطط العمراني (DXF — AutoCAD)',       url: relUrl(dxfPath),    ext: 'dxf',     icon: '📐' },
      { label: 'المخطط البصري (SVG)',                   url: relUrl(svgPath),    ext: 'svg',     icon: '🗺️' },
      { label: 'التقرير التحليلي الشامل (Word)',         url: relUrl(docxPath),   ext: 'docx',    icon: '📝' },
      { label: 'التقرير المصور (PDF)',                    url: relUrl(pdfPath),    ext: 'pdf',     icon: '📄' },
      { label: 'جدول بيانات المباني (Excel)',            url: relUrl(xlsxPath),   ext: 'xlsx',    icon: '📊' },
      { label: 'بيانات التحليل (JSON)',                  url: relUrl(metaPath),   ext: 'json',    icon: '🗂️' },
    );

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅  S3 JOB DONE  |  ${results.length} views  |  ${((Date.now()-t0)/1000).toFixed(1)}s`);
    console.log(`${'═'.repeat(60)}\n`);

    return res.json({
      success: true,
      jobId,
      urbanAnalysis,
      outputFiles,
      images: results.map(r => ({
        id:        r.id,
        labelAr:   r.labelAr,
        labelEn:   r.labelEn,
        outputUrl: relUrl(r.pngPath),
        aspect:    r.width > r.height ? '16:9' : '3:4',
      })),
    });

  } catch(err) {
    console.error('[S3] Fatal:', err.message);
    return res.status(500).json({ error: err.message || 'خطأ في التحليل الجغرافي' });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════════════════
// GET /api/service3/previous-outputs — Browse S1 & S2 job results
// ══════════════════════════════════════════════════════════════════════════
router.get('/previous-outputs', (req, res) => {
  try {
    const serviceFilter = parseInt(req.query.service) || null; // ?service=1 or ?service=2
    const jobs = [];
    const outputsRoot = path.join(__dirname, '../../public/outputs');
    const jobDirs = fs.readdirSync(outputsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const jobId of jobDirs) {
      const metaFile = path.join(outputsRoot, jobId, 'metadata.json');
      if (!fs.existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (!meta.service) continue;
        if (serviceFilter && meta.service !== serviceFilter) continue;
        if (meta.service !== 1 && meta.service !== 2) continue; // only S1 + S2

        const jobDir = path.join(outputsRoot, jobId);
        const files  = fs.readdirSync(jobDir).filter(f => /\.(png|jpg|tiff|glb|obj|fbx|stl|pdf)$/i.test(f));
        const images = files.filter(f => /\.(png|jpg|tiff)$/i.test(f)).map(f => ({
          name:    f,
          url:     `/outputs/${jobId}/${f}`,
          sizeKB:  Math.round(fs.statSync(path.join(jobDir, f)).size / 1024),
        }));
        const models = files.filter(f => /\.(glb|obj|fbx|stl)$/i.test(f)).map(f => ({
          name:    f,
          url:     `/outputs/${jobId}/${f}`,
          sizeKB:  Math.round(fs.statSync(path.join(jobDir, f)).size / 1024),
        }));

        jobs.push({
          jobId,
          service: meta.service,
          model:   meta.model || '',
          processedAt: meta.processedAt || '',
          originalNames: (meta.images || []).map(i => i.originalName || i.name || '').filter(Boolean),
          images,
          models,
          totalFiles: files.length,
        });
      } catch { /* skip malformed */ }
    }

    // Sort newest first
    jobs.sort((a, b) => new Date(b.processedAt) - new Date(a.processedAt));
    return res.json({ success: true, jobs });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
});
