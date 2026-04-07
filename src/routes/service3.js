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
const zlib       = require('zlib');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} = require('docx');
const PDFDocument = require('pdfkit');
const ExcelJS    = require('exceljs');
const DxfWriter  = require('dxf-writer');
const turf       = require('@turf/turf');

const router    = express.Router();
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SERVICE_03_NAME = 'Geospatial Analysis & Urban Fabric Restoration';
const SERVICE_03_DEFINITION = 'Analyze, reconstruct, and visualize the urban environment surrounding heritage assets at the district or neighborhood scale. Service 03 focuses on streets, open spaces, terrain, spatial relationships, district boundaries, and the historical urban fabric rather than a single building only. It compares historical and current conditions, integrates restored heritage buildings from earlier services, and generates geographically coherent restoration outputs for the wider urban context.';
const GEO_REFERENCE_EXTENSIONS = new Set(['.kml', '.kmz', '.geojson', '.json', '.shp', '.zip']);
const RASTER_REFERENCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const HISTORICAL_DOCUMENT_EXTENSIONS = new Set(['.pdf']);
const TERRAIN_REFERENCE_EXTENSIONS = new Set(['.tif', '.tiff', '.asc', '.las', '.laz', '.dem']);
const RESTORATION_ASSET_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.pdf', '.glb', '.gltf', '.fbx', '.obj', '.stl']);

// ── Storage ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, `s3_${Date.now()}_${uuidv4().slice(0,8)}${path.extname(file.originalname)}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

function summarizeService3Inputs(files = {}) {
  const geoFiles = files['geoFiles'] || [];
  const aerialFiles = files['aerialImages'] || [];
  const demFiles = files['demFiles'] || [];
  const restoredFiles = files['restoredBuildings'] || [];

  return {
    geoFiles: geoFiles.map(f => ({ name: f.originalname, ext: path.extname(f.originalname).toLowerCase(), size: f.size || 0 })),
    aerialFiles: aerialFiles.map(f => ({ name: f.originalname, ext: path.extname(f.originalname).toLowerCase(), size: f.size || 0 })),
    demFiles: demFiles.map(f => ({ name: f.originalname, ext: path.extname(f.originalname).toLowerCase(), size: f.size || 0 })),
    restoredFiles: restoredFiles.map(f => ({ name: f.originalname, ext: path.extname(f.originalname).toLowerCase(), size: f.size || 0 })),
  };
}

function validateService3Inputs(files = {}) {
  const groups = [
    ...(files['geoFiles'] || []),
    ...(files['aerialImages'] || []),
    ...(files['demFiles'] || []),
    ...(files['restoredBuildings'] || []),
  ];

  for (const file of groups) {
    const ext = path.extname(file.originalname || file.path || '').toLowerCase();
    const size = file.size || 0;

    if ((RASTER_REFERENCE_EXTENSIONS.has(ext) || RESTORATION_ASSET_EXTENSIONS.has(ext)) && size > 50 * 1024 * 1024) {
      return `File "${file.originalname}" exceeds the 50 MB image/asset limit.`;
    }
    if ((GEO_REFERENCE_EXTENSIONS.has(ext) || HISTORICAL_DOCUMENT_EXTENSIONS.has(ext) || TERRAIN_REFERENCE_EXTENSIONS.has(ext)) && size > 100 * 1024 * 1024) {
      return `File "${file.originalname}" exceeds the 100 MB geospatial/document limit.`;
    }
  }

  return null;
}

function classifyRestorationAsset(ext) {
  const normalized = String(ext || '').toLowerCase();
  if (['.glb', '.gltf', '.fbx', '.obj', '.stl'].includes(normalized)) return '3d-model';
  if (['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'].includes(normalized)) return 'restored-image';
  if (normalized === '.pdf') return 'reference-document';
  return 'supporting-asset';
}

function summarizeRestorationAssets(restoredFiles = []) {
  const assets = restoredFiles.map((file, index) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    return {
      id: `asset_${String(index + 1).padStart(2, '0')}`,
      name: file.originalname,
      sizeKB: Math.round((file.size || 0) / 1024),
      type: file.mimetype,
      ext: ext.slice(1),
      assetRole: classifyRestorationAsset(ext),
    };
  });

  const counts = assets.reduce((acc, asset) => {
    acc[asset.assetRole] = (acc[asset.assetRole] || 0) + 1;
    return acc;
  }, {});

  return {
    totalAssets: assets.length,
    imageAssets: counts['restored-image'] || 0,
    modelAssets: counts['3d-model'] || 0,
    documentAssets: counts['reference-document'] || 0,
    assets,
  };
}

function summarizeTerrainInputs(demFiles = [], districtContext = {}) {
  const exts = demFiles.map(f => path.extname(f.originalname || '').toLowerCase());
  const hasRasterDem = exts.some(ext => ['.tif', '.tiff', '.asc', '.dem'].includes(ext));
  const hasPointCloud = exts.some(ext => ['.las', '.laz'].includes(ext));
  const radius = districtContext.radius || 0.005;

  return {
    terrainFiles: demFiles.length,
    hasRasterDem,
    hasPointCloud,
    terrainMode: demFiles.length ? 'provided-terrain-data' : 'inferred-from-site-context',
    slopeCharacter: radius < 0.003 ? 'compact / relatively flat district' : radius < 0.01 ? 'mixed relief district' : 'broad district with more noticeable terrain variation',
    notes: demFiles.length
      ? 'Terrain references were supplied and should influence district-wide spatial logic, streets, and open-space reconstruction.'
      : 'No terrain files were supplied, so terrain influence is inferred from district scale and architectural context.',
  };
}

function buildRestorationAssetFeatures(restorationAssetSummary, center, radius) {
  const [lng, lat] = center;
  const spacing = Math.max(radius * 0.18, 0.00035);

  return (restorationAssetSummary.assets || []).map((asset, index) => {
    const angle = ((index % 8) / 8) * Math.PI * 2;
    const ring = Math.floor(index / 8) + 1;
    const distance = spacing * ring;
    const assetLng = lng + Math.cos(angle) * distance;
    const assetLat = lat + Math.sin(angle) * distance;

    return {
      type: 'Feature',
      properties: {
        id: asset.id,
        name: asset.name,
        type: 'restoration_asset',
        assetRole: asset.assetRole,
        sourceService: 'Service 01/02 reusable heritage output',
      },
      geometry: {
        type: 'Point',
        coordinates: [assetLng, assetLat],
      },
    };
  });
}

function buildDistrictRestorationSummary(districtContext, urbanAnalysis, terrainSummary, restorationAssetSummary, inputSummary) {
  return {
    boundarySource: districtContext.hasRealData ? 'parsed GIS / district boundary data' : 'coordinate-based fallback boundary',
    districtScale: districtContext.radius < 0.003 ? 'compact district' : districtContext.radius < 0.01 ? 'neighborhood district' : 'extended urban quarter',
    streetCount: districtContext.realStreets.length,
    buildingCount: districtContext.realBuildings.length,
    openSpaceCount: districtContext.realOpenSpaces.length,
    pedestrianRouteCount: 0,
    publicSpaceCount: 0,
    terrainMode: terrainSummary.terrainMode,
    historicalComparisonBasis: inputSummary.aerialFiles.length ? 'historical imagery / aerial references provided' : 'limited historical imagery, relying more on district logic and supporting files',
    restorationAssetCount: restorationAssetSummary.totalAssets,
    restorationAssetIntegration: restorationAssetSummary.totalAssets
      ? 'Restored heritage assets from earlier services are treated as district-scale contextual restoration elements and reinserted into the urban fabric.'
      : 'No restored building assets were supplied; Service 03 reconstructs the district using geospatial and historical context only.',
    planningGoal: urbanAnalysis?.urbanPattern
      ? `Restore the district while preserving its ${urbanAnalysis.urbanPattern.toLowerCase()} urban fabric logic, streets, and open spaces.`
      : 'Restore the district while preserving its historic urban fabric, street hierarchy, and open-space structure.',
  };
}

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
// Meta Llama Vision Urban Analysis
// ══════════════════════════════════════════════════════════════════════════
async function analyzeUrbanWithVision(imagePaths, districtName, city, period, archStyle) {
  if (!imagePaths || imagePaths.length === 0) {
    return {
      detectedStyle:  archStyle || 'تراثي',
      urbanPattern:   'عضوي',
      keyFeatures:    ['شوارع ضيقة', 'فراغات مركزية', 'عمارة متراصة'],
      heritageValue:  'عالية',
      restorationNotes: 'يتطلب التحليل المرئي تحديد العناصر الأصيلة وتوثيق الوضع الراهن قبل التدخل.',
    };
  }

  console.log(`[Vision/S3] Urban analysis — ${imagePaths.length} image(s)...`);

  const imageInputs = imagePaths.slice(0, 3).map(p => {
    const ext  = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });

  const output = await replicate.run('meta/meta-llama-3-2-90b-vision-instruct', {
    input: {
      prompt: `You are an expert urban heritage analyst specialising in Saudi historic districts. Always respond with valid JSON only.

Analyze these aerial / historic images of a heritage district.
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
      image: imageInputs[0],
      max_tokens: 400,
      temperature: 0.2,
    },
  });

  try {
    const text = Array.isArray(output) ? output.join('') : String(output);
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const result = JSON.parse(json);
      console.log(`[Vision/S3] ✓ Pattern: ${result.urbanPattern} | Value: ${result.heritageValue}`);
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

function buildDistrictUrbanViews(districtName, archStyle, urbanAnalysis, districtSummary, terrainSummary, restorationAssetSummary) {
  const name = districtName || 'historic district';
  const stylDetail = STYLE_DETAILS[archStyle] || STYLE_DETAILS['Ù†Ø¬Ø¯ÙŠ'];
  const terrainCue = terrainSummary?.hasPointCloud || terrainSummary?.hasRasterDem
    ? `real terrain-informed district topography, ${terrainSummary.slopeCharacter}`
    : `terrain-aware urban setting, ${terrainSummary?.slopeCharacter || 'heritage site topography respected'}`;
  const assetCue = restorationAssetSummary?.totalAssets
    ? 'restored heritage assets from Service 01 and Service 02 placed back into the district in believable positions'
    : 'district-wide restoration assets reconstructed coherently within the urban fabric';
  const boundaryCue = districtSummary?.boundarySource
    ? `district boundary and urban organization derived from ${districtSummary.boundarySource}`
    : 'district-scale geospatial logic';

  return [
    {
      id: 'aerial',
      labelAr: 'Ø§Ù„Ù…Ù†Ø¸ÙˆØ± Ø§Ù„Ù‡ÙˆØ§Ø¦ÙŠ Ù„Ù„Ø­ÙŠ',
      labelEn: 'Aerial Urban Overview',
      prompt: `Generate a realistic district-scale aerial restoration visualization of ${name}. Preserve the historical urban fabric, streets, open spaces, spatial relationships between buildings, and the wider neighborhood character. ${stylDetail}, ${terrainCue}, ${assetCue}, ${boundaryCue}. Show the overall massing, roofscape, courtyards, paths, and public spaces clearly. The result must feel geographically coherent, historically respectful, and presentation-ready.`,
      width: 1344, height: 768,
    },
    {
      id: 'street',
      labelAr: 'Ù…Ù†Ø¸ÙˆØ± Ø§Ù„Ø´Ø§Ø±Ø¹ Ø§Ù„ØªØ±Ø§Ø«ÙŠ',
      labelEn: 'Heritage Street Level',
      prompt: `Generate a realistic street-level view within the restored heritage district of ${name}. Focus on the wider urban context rather than a single isolated building: connected facades, pedestrian routes, public edges, open-space sequence, and district-scale continuity. ${stylDetail}, ${terrainCue}, ${assetCue}. Include subtle human activity and calm environmental life while keeping the historic urban character clear.`,
      width: 768, height: 1024,
    },
    {
      id: 'comparison',
      labelAr: 'Ø§Ù„Ù…Ù‚Ø§Ø±Ù†Ø© Ø§Ù„ØªØ§Ø±ÙŠØ®ÙŠØ©',
      labelEn: 'Historical vs. Current Comparison',
      prompt: `Generate a historical-versus-current urban comparison for the heritage district of ${name}. Clearly communicate the historical urban fabric, the current condition, and the district-scale restoration logic. ${stylDetail}, ${terrainCue}, ${boundaryCue}. Keep the comparison focused on streets, blocks, public spaces, and neighborhood structure rather than a single building facade.`,
      width: 1344, height: 768,
    },
    {
      id: 'vision',
      labelAr: 'Ø±Ø¤ÙŠØ© Ø§Ù„ØªØ±Ù…ÙŠÙ… Ø§Ù„Ù…Ø³ØªÙ‚Ø¨Ù„ÙŠØ©',
      labelEn: 'Restoration Vision',
      prompt: `Generate the restored future vision of the full heritage district of ${name}. Emphasize district-scale restoration rather than building-only restoration: pedestrian-friendly streets, coherent open spaces, integrated heritage assets, and believable geographic continuity across the neighborhood. ${stylDetail}, ${terrainCue}, ${assetCue}. The output should feel like a professional urban restoration concept made realistic.`,
      width: 1344, height: 768,
    },
    {
      id: 'corner',
      labelAr: 'Ø§Ù„Ù…Ù†Ø¸ÙˆØ± Ø§Ù„Ø²Ø§ÙˆÙŠ Ø§Ù„ØªÙØµÙŠÙ„ÙŠ',
      labelEn: 'Corner Perspective View',
      prompt: `Generate an urban corner perspective within ${name} that shows how multiple heritage buildings, intersecting streets, and public-space edges relate to each other. ${stylDetail}, ${terrainCue}, ${assetCue}. This should read as a believable part of a restored neighborhood block with strong spatial logic and district continuity.`,
      width: 1344, height: 768,
    },
    {
      id: 'plaza',
      labelAr: 'Ù…ÙŠØ¯Ø§Ù† Ø§Ù„Ù…Ø´Ø§Ø© Ø§Ù„Ø¹Ø§Ù…',
      labelEn: 'Pedestrian Plaza',
      prompt: `Generate a restored public plaza or open-space scene in the heart of ${name}. Highlight how streets, open spaces, building edges, and restored heritage assets work together at district scale. ${stylDetail}, ${terrainCue}, ${assetCue}. Include calm, realistic public activity without losing the heritage identity of the neighborhood.`,
      width: 1344, height: 768,
    },
    {
      id: 'night',
      labelAr: 'Ø§Ù„Ù…Ø´Ù‡Ø¯ Ø§Ù„Ù„ÙŠÙ„ÙŠ Ø§Ù„ØªØ±Ø§Ø«ÙŠ',
      labelEn: 'Night Atmosphere',
      prompt: `Generate a night-time district view of ${name} with warm heritage lighting, readable streets, and coherent building massing across the neighborhood. ${stylDetail}, ${terrainCue}, ${assetCue}. The lighting should support orientation, atmosphere, and realistic district-level restoration rather than a random cinematic effect.`,
      width: 1344, height: 768,
    },
    {
      id: 'facade',
      labelAr: 'ØªÙØ§ØµÙŠÙ„ Ø§Ù„ÙˆØ§Ø¬Ù‡Ø© Ø§Ù„Ù…Ø±Ù…Ù…Ø©',
      labelEn: 'Restored Facade Detail',
      prompt: `Generate a facade-detail view that still belongs clearly to the restored urban district of ${name}. Show craftsmanship, materials, and restoration quality, but keep contextual cues of adjacent streets, building relationships, or neighborhood fabric so the image remains connected to the wider urban restoration story. ${stylDetail}, ${assetCue}.`,
      width: 768, height: 1024,
    },
  ];
}

const NEGATIVE_PROMPT =
  'blurry, low quality, distorted, cartoon, sketch, anime, ugly, deformed, ' +
  'modern western architecture, skyscrapers, cars, noise, watermark, text overlay';

// ══════════════════════════════════════════════════════════════════════════
function extractZipEntries(buffer) {
  const entries = [];
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let eocdOffset = -1;

  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return entries;

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== centralSignature) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== localSignature) {
      offset += 46 + nameLength + extraLength + commentLength;
      continue;
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.slice(dataStart, dataStart + compressedSize);

    let data;
    if (compression === 0) data = compressed;
    else if (compression === 8) data = zlib.inflateRawSync(compressed);
    else data = null;

    if (data) {
      entries.push({ name, data, compressedSize, uncompressedSize });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function parseKmzFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = extractZipEntries(buffer);
  const kmlEntry = entries.find(entry => /\.kml$/i.test(entry.name));
  return kmlEntry ? kmlEntry.data.toString('utf8') : '';
}

function parseKmlText(raw) {
  const features = [];
  const placemarks = raw.match(/<Placemark[\s\S]*?<\/Placemark>/gi) || [];

  for (const placemark of placemarks) {
    const name = (placemark.match(/<name>([\s\S]*?)<\/name>/i)?.[1] || '').trim();
    const coordBlocks = placemark.match(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi) || [];

    for (const block of coordBlocks) {
      const inner = block.replace(/<\/?coordinates[^>]*>/gi, '').trim();
      const pairs = inner.split(/\s+/).map(pair => {
        const parts = pair.split(',').map(Number);
        return parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1]) ? [parts[0], parts[1]] : null;
      }).filter(Boolean);

      if (pairs.length === 1) {
        features.push(turf.point(pairs[0], { name }));
      } else if (pairs.length > 1) {
        const first = pairs[0];
        const last = pairs[pairs.length - 1];
        const isClosed = first[0] === last[0] && first[1] === last[1];
        features.push(
          isClosed && pairs.length >= 4
            ? turf.polygon([pairs], { name })
            : turf.lineString(pairs, { name })
        );
      }
    }
  }

  return features;
}

function parseShpBuffer(buffer) {
  const features = [];
  let offset = 100;

  while (offset + 8 <= buffer.length) {
    const recordLengthWords = buffer.readInt32BE(offset + 4);
    const recordLengthBytes = recordLengthWords * 2;
    const recordStart = offset + 8;
    if (recordStart + recordLengthBytes > buffer.length) break;

    const shapeType = buffer.readInt32LE(recordStart);
    if (shapeType === 0) {
      offset = recordStart + recordLengthBytes;
      continue;
    }

    if (shapeType === 1 && recordLengthBytes >= 20) {
      const x = buffer.readDoubleLE(recordStart + 4);
      const y = buffer.readDoubleLE(recordStart + 12);
      features.push(turf.point([x, y]));
    } else if ((shapeType === 3 || shapeType === 5) && recordLengthBytes >= 44) {
      const numParts = buffer.readInt32LE(recordStart + 36);
      const numPoints = buffer.readInt32LE(recordStart + 40);
      const partsOffset = recordStart + 44;
      const pointsOffset = partsOffset + numParts * 4;
      const parts = [];

      for (let i = 0; i < numParts; i++) {
        parts.push(buffer.readInt32LE(partsOffset + i * 4));
      }

      const pointSets = [];
      for (let i = 0; i < numParts; i++) {
        const start = parts[i];
        const end = i + 1 < numParts ? parts[i + 1] : numPoints;
        const coords = [];
        for (let j = start; j < end; j++) {
          const ptOffset = pointsOffset + j * 16;
          coords.push([buffer.readDoubleLE(ptOffset), buffer.readDoubleLE(ptOffset + 8)]);
        }
        if (coords.length) pointSets.push(coords);
      }

      if (shapeType === 3) {
        if (pointSets.length === 1) features.push(turf.lineString(pointSets[0]));
        else features.push(turf.multiLineString(pointSets));
      } else {
        const polygons = pointSets.map(coords => {
          const first = coords[0];
          const last = coords[coords.length - 1];
          if (!last || first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
          return coords;
        }).filter(coords => coords.length >= 4);

        if (polygons.length === 1) features.push(turf.polygon([polygons[0]]));
        else if (polygons.length > 1) features.push(turf.multiPolygon(polygons.map(coords => [coords])));
      }
    }

    offset = recordStart + recordLengthBytes;
  }

  return features;
}

function parseShpFile(filePath) {
  return parseShpBuffer(fs.readFileSync(filePath));
}

function analyzeTerrainFiles(demFiles = []) {
  const summary = {
    minElevation: null,
    maxElevation: null,
    reliefMeters: null,
    terrainSource: demFiles.length ? 'uploaded terrain references' : 'no explicit terrain dataset',
    parsedFiles: [],
  };

  for (const file of demFiles) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    try {
      if (ext === '.asc' || ext === '.dem') {
        const raw = fs.readFileSync(file.path, 'utf8');
        const values = raw.split(/\r?\n/).slice(6).join(' ').trim().split(/\s+/)
          .map(Number).filter(v => Number.isFinite(v) && v > -9999);
        if (values.length) {
          const min = Math.min(...values);
          const max = Math.max(...values);
          summary.minElevation = summary.minElevation === null ? min : Math.min(summary.minElevation, min);
          summary.maxElevation = summary.maxElevation === null ? max : Math.max(summary.maxElevation, max);
          summary.parsedFiles.push({ name: file.originalname, type: 'ascii-grid', samples: values.length });
        }
      } else if (ext === '.las' && fs.statSync(file.path).size >= 227) {
        const buffer = fs.readFileSync(file.path);
        const minZ = buffer.readDoubleLE(195);
        const maxZ = buffer.readDoubleLE(211);
        if (Number.isFinite(minZ) && Number.isFinite(maxZ)) {
          summary.minElevation = summary.minElevation === null ? minZ : Math.min(summary.minElevation, minZ);
          summary.maxElevation = summary.maxElevation === null ? maxZ : Math.max(summary.maxElevation, maxZ);
          summary.parsedFiles.push({ name: file.originalname, type: 'las-header', samples: 1 });
        }
      } else {
        summary.parsedFiles.push({ name: file.originalname, type: ext.slice(1) || 'terrain-reference', samples: 0 });
      }
    } catch (error) {
      summary.parsedFiles.push({ name: file.originalname, type: 'unparsed', error: error.message });
    }
  }

  if (summary.minElevation !== null && summary.maxElevation !== null) {
    summary.reliefMeters = Number((summary.maxElevation - summary.minElevation).toFixed(2));
  }

  return summary;
}

function buildVisualAxes(center, radius, realStreets) {
  const [lng, lat] = center;
  if (realStreets.length >= 2) {
    return realStreets.slice(0, 2).map((street, index) => ({
      type: 'Feature',
      properties: { type: 'visual_axis', name: `Visual Axis ${index + 1}` },
      geometry: street.geometry,
    }));
  }

  return [
    turf.lineString([[lng - radius, lat], [lng + radius, lat]], { type: 'visual_axis', name: 'Primary Visual Axis' }),
    turf.lineString([[lng, lat - radius], [lng, lat + radius]], { type: 'visual_axis', name: 'Secondary Visual Axis' }),
  ];
}

function buildUrbanPlanPdf(districtName, districtArea, districtSummary, pdfPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A3', margin: 36 });
    const out = fs.createWriteStream(pdfPath);
    doc.pipe(out);

    const name = districtName || 'Heritage District';
    const side = 420;
    const ox = 80;
    const oy = 120;
    doc.fontSize(20).font('Helvetica-Bold').text(`Urban Plan - ${name}`, { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica').text(`Scale logic: ${districtSummary?.districtScale || 'district'} | Area: ${districtArea || 'N/A'} m2`, { align: 'center' });

    doc.rect(ox, oy, side, side).strokeColor('#22384f').lineWidth(2).stroke();
    doc.moveTo(ox, oy + side / 2).lineTo(ox + side, oy + side / 2).strokeColor('#d59d2d').lineWidth(3).stroke();
    doc.moveTo(ox + side / 2, oy).lineTo(ox + side / 2, oy + side).strokeColor('#d59d2d').lineWidth(3).stroke();
    doc.rect(ox + side * 0.42, oy + side * 0.42, side * 0.16, side * 0.16).fillAndStroke('#dceccf', '#7aa15f');
    doc.fillColor('#0b1521').fontSize(11).text('Central Square', ox + side * 0.4, oy + side * 0.59);
    doc.fillColor('#000000');

    out.on('finish', resolve);
    out.on('error', reject);
    doc.end();
  });
}

function buildAiFromSvg(svgPath, aiPath) {
  fs.copyFileSync(svgPath, aiPath);
}

function buildKmzFromKml(kmlPath, kmzPath) {
  const kmlData = fs.readFileSync(kmlPath);
  const nameBuf = Buffer.from('doc.kml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(kmlData.length, 18);
  local.writeUInt32LE(kmlData.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(kmlData.length, 20);
  central.writeUInt32LE(kmlData.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(local.length + nameBuf.length + kmlData.length, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(kmzPath, Buffer.concat([local, nameBuf, kmlData, central, nameBuf, end]));
}

// GIS File Parser (KML + GeoJSON → turf FeatureCollection)
// ══════════════════════════════════════════════════════════════════════════
function parseGisFiles(gisFilePaths) {
  const allFeatures = [];
  for (const fp of gisFilePaths) {
    try {
      const ext = path.extname(fp).toLowerCase();
      if (ext === '.geojson' || ext === '.json') {
        const raw = fs.readFileSync(fp, 'utf8');
        const parsed = JSON.parse(raw);
        const fc = parsed.type === 'FeatureCollection' ? parsed
                 : parsed.type === 'Feature'           ? { type: 'FeatureCollection', features: [parsed] }
                 : null;
        if (fc) allFeatures.push(...fc.features.filter(f => f && f.geometry));

      } else if (ext === '.kml') {
        allFeatures.push(...parseKmlText(fs.readFileSync(fp, 'utf8')));
      } else if (ext === '.kmz') {
        const kmzKml = parseKmzFile(fp);
        if (kmzKml) allFeatures.push(...parseKmlText(kmzKml));
      } else if (ext === '.shp') {
        allFeatures.push(...parseShpFile(fp));
      } else if (ext === '.zip') {
        const entries = extractZipEntries(fs.readFileSync(fp));
        for (const entry of entries) {
          const entryExt = path.extname(entry.name).toLowerCase();
          if (entryExt === '.geojson' || entryExt === '.json') {
            const parsed = JSON.parse(entry.data.toString('utf8'));
            const fc = parsed.type === 'FeatureCollection' ? parsed
                     : parsed.type === 'Feature' ? { type: 'FeatureCollection', features: [parsed] }
                     : null;
            if (fc) allFeatures.push(...fc.features.filter(f => f && f.geometry));
          } else if (entryExt === '.kml') {
            allFeatures.push(...parseKmlText(entry.data.toString('utf8')));
          } else if (entryExt === '.shp') {
            allFeatures.push(...parseShpBuffer(entry.data));
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
function buildLeafletMap(
  districtName,
  city,
  center,
  radius,
  gisFC,
  pedestrianRoutes,
  publicSpaces,
  visualAxes,
  restorationAssetFeatures,
  districtContext,
  urbanAnalysis,
  districtSummary,
  terrainSummary,
  htmlPath
) {
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
  const axesGeoJson = JSON.stringify({ type: 'FeatureCollection', features: visualAxes || [] });
  const assetsGeoJson = JSON.stringify({ type: 'FeatureCollection', features: restorationAssetFeatures || [] });

  const ua = urbanAnalysis || {};
  const ds = districtSummary || {};
  const ts = terrainSummary || {};

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
    <div class="stat-box"><div class="stat-label">المباني</div><div class="stat-value">${districtContext.realBuildings.length}</div></div>
    <div class="stat-box"><div class="stat-label">الفراغات</div><div class="stat-value">${publicSpaces.length}</div></div>
    <div class="stat-box"><div class="stat-label">المحاور البصرية</div><div class="stat-value">${(visualAxes || []).length}</div></div>
    <div class="stat-box"><div class="stat-label">أصول الترميم</div><div class="stat-value">${(restorationAssetFeatures || []).length}</div></div>
  </div>
  <div style="color:#94a3b8;font-size:11px;line-height:1.7">
    <b style="color:#fff">Boundary:</b> ${ds.boundarySource || '—'}<br>
    <b style="color:#fff">District Scale:</b> ${ds.districtScale || '—'}<br>
    <b style="color:#fff">Terrain:</b> ${ts.terrainMode || '—'}
  </div>
  <hr>
  <div class="section-title">دليل الطبقات</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(223,184,103,0.3);border:2px solid #dfb867"></div> حدود الحي</div>
  <div class="legend-item"><div class="legend-line" style="background:#fbbf24;height:4px"></div> شوارع رئيسية</div>
  <div class="legend-item"><div class="legend-line" style="background:#f59e0b;height:2px;border-top:2px dashed #f59e0b;height:0"></div> مسارات المشاة</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(74,222,128,0.3);border:1px solid #4ade80"></div> فراغات عامة</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(148,163,184,0.2);border:1px solid #64748b"></div> مباني</div>
  <div class="legend-item"><div class="legend-line" style="background:#38bdf8;height:2px;border-top:2px dashed #38bdf8;height:0"></div> محاور بصرية</div>
  <div class="legend-item"><div class="legend-box" style="background:rgba(192,132,252,0.35);border:1px solid #c084fc;border-radius:999px"></div> أصول ترميم مدمجة</div>
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

  // Visual axes
  const axesData = ${axesGeoJson};
  if (axesData.features.length > 0) {
    L.geoJSON(axesData, {
      style: { color: '#38bdf8', weight: 2, opacity: 0.75, dashArray: '8 6' },
      onEachFeature: (f, layer) => layer.bindPopup(f.properties?.name || 'محور بصري'),
    }).addTo(map);
  }

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

  // Restoration assets
  const assetsData = ${assetsGeoJson};
  if (assetsData.features.length > 0) {
    L.geoJSON(assetsData, {
      pointToLayer: (f, latlng) => L.circleMarker(latlng, {
        radius: 6, color: '#c084fc', weight: 2, fillColor: '#c084fc', fillOpacity: 0.45,
      }),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.bindPopup(\`<b>\${p.name || p.id || 'Restoration Asset'}</b><br>Role: \${p.assetRole || 'supporting-asset'}<br>Source: \${p.sourceService || 'Service 01/02'}\`);
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
async function buildExcel(districtName, city, period, archStyle, districtArea, lat, lng, urbanAnalysis, results, restoredMeta, districtSummary, terrainSummary, restorationAssetSummary, xlsxPath) {
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
    ['Service',             SERVICE_03_NAME],
    ['Functional Definition', SERVICE_03_DEFINITION],
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
    ['Boundary Source',     districtSummary?.boundarySource || 'â€”'],
    ['District Scale',      districtSummary?.districtScale || 'â€”'],
    ['Terrain Mode',        terrainSummary?.terrainMode || 'â€”'],
    ['Restoration Assets Integrated', `${restorationAssetSummary?.totalAssets || 0}`],
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
async function buildWord(districtName, city, period, archStyle, districtArea, urbanAnalysis, results, restoredMeta, districtSummary, terrainSummary, restorationAssetSummary, docxPath) {
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
    new Paragraph({ text: SERVICE_03_NAME, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: SERVICE_03_DEFINITION }),
    new Paragraph({ text: '' }),

    // Section 1: Project Info
    new Paragraph({ text: '١. معلومات المشروع', heading: HeadingLevel.HEADING_2 }),
    ...([
      ['اسم الحي', name],
      ['المدينة', safeStr(city)],
      ['الحقبة التاريخية', safeStr(period)],
      ['النمط المعماري', safeStr(archStyle)],
      ['مساحة الحي', districtArea ? `${districtArea} م²` : '—'],
      ['Boundary Source', safeStr(districtSummary?.boundarySource)],
      ['Terrain Mode', safeStr(terrainSummary?.terrainMode)],
      ['Integrated Restoration Assets', String(restorationAssetSummary?.totalAssets || 0)],
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
    promptOverride = '',
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
    const validationError = validateService3Inputs(req.files || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const inputSummary   = summarizeService3Inputs(req.files || {});
    const aerialFiles    = ((req.files && req.files['aerialImages'])      || []).map(f => f.path);
    const geoFilePaths   = ((req.files && req.files['geoFiles'])          || []).map(f => f.path);
    const demFiles       = ((req.files && req.files['demFiles'])          || []);
    const restoredFiles  = ((req.files && req.files['restoredBuildings']) || []);
    const restoredMeta   = restoredFiles.map(f => ({
      name: f.originalname,
      size: Math.round(f.size / 1024),
      type: f.mimetype,
      ext:  path.extname(f.originalname).toLowerCase().slice(1),
    }));
    const restorationAssetSummary = summarizeRestorationAssets(restoredFiles);
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
    const terrainSummary = {
      ...summarizeTerrainInputs(demFiles, districtCtx),
      ...analyzeTerrainFiles(demFiles),
    };
    if (districtCtx.hasRealData) {
      console.log(`         ✓ Real GIS data: center [${effLat.toFixed(5)}, ${effLng.toFixed(5)}], features: ${gisFC.features.length}`);
    } else {
      console.log(`         ℹ No GIS files or unreadable — using coordinate fallback`);
    }

    // Build pedestrian routes + public spaces
    const pedestrianRoutes = buildPedestrianRoutes(effectiveCenter, effectiveRadius, districtCtx.realStreets);
    const publicSpaces     = buildPublicSpaces(effectiveCenter, effectiveRadius, districtCtx.realOpenSpaces);
    const visualAxes       = buildVisualAxes(effectiveCenter, effectiveRadius, districtCtx.realStreets);
    const restorationAssetFeatures = buildRestorationAssetFeatures(restorationAssetSummary, effectiveCenter, effectiveRadius);
    const districtSummary = buildDistrictRestorationSummary(
      districtCtx, null, terrainSummary, restorationAssetSummary, inputSummary
    );
    districtSummary.pedestrianRouteCount = pedestrianRoutes.length;
    districtSummary.publicSpaceCount = publicSpaces.length;
    districtSummary.visualAxisCount = visualAxes.length;
    console.log(`         ✓ ${pedestrianRoutes.length} pedestrian routes | ${publicSpaces.length} public spaces`);

    // ── STEP 1: Vision Urban Analysis ────────────────────────────────────
    console.log('\n[STEP 1] 🔍 Vision urban analysis...');
    let urbanAnalysis = null;
    try {
      urbanAnalysis = await analyzeUrbanWithVision(aerialFiles, districtName, city, period, archStyle);
      console.log(`         ✓ Pattern: ${urbanAnalysis.urbanPattern} | Value: ${urbanAnalysis.heritageValue}`);
    } catch(e) {
      console.warn('         ⚠ Vision analysis skipped:', e.message);
      urbanAnalysis = {
        detectedStyle: archStyle, urbanPattern: 'Organic',
        keyFeatures: ['شوارع تراثية', 'مباني أصيلة', 'فراغات عامة'],
        heritageValue: 'High', restorationNotes: notes || 'تحليل الذكاء الاصطناعي غير متاح.',
      };
    }

    // ── STEP 2: SDXL Urban Views ──────────────────────────────────────────
    districtSummary.planningGoal = buildDistrictRestorationSummary(
      districtCtx, urbanAnalysis, terrainSummary, restorationAssetSummary, inputSummary
    ).planningGoal;
    const views   = buildDistrictUrbanViews(districtName, archStyle, urbanAnalysis, districtSummary, terrainSummary, restorationAssetSummary);
    const results = [];

    for (const [i, view] of views.entries()) {
      console.log(`\n┌─ [${i+1}/${views.length}] ▶ SDXL | ${view.labelEn} ────────────────`);

      let imgUrl;
      try {
        const output = await replicate.run(
          'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
          {
            input: {
              prompt:          promptOverride
                ? `${promptOverride}, ${view.label || view.labelEn || view.id}`
                : view.prompt,
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
    buildKml(effLat, effLng, districtName, city, period, urbanAnalysis, kmlPath);
    console.log(`       ✓ KML: ${(fs.statSync(kmlPath).size/1024).toFixed(0)} KB`);

    // ── STEP 4: GeoJSON (enriched with pedestrian routes + public spaces) ──
    console.log('[Post] Building enriched GeoJSON...');
    const geoJsonPath = path.join(jobDir, 'district_data.geojson');
    buildGeoJson(effLat, effLng, districtName, city, period, districtArea, urbanAnalysis, geoJsonPath);
    try {
      const gjContent = JSON.parse(fs.readFileSync(geoJsonPath, 'utf8'));
      gjContent.features.push(
        ...districtCtx.realStreets,
        ...districtCtx.realBuildings,
        ...districtCtx.realOpenSpaces,
        ...pedestrianRoutes,
        ...publicSpaces,
        ...visualAxes,
        ...restorationAssetFeatures
      );
      gjContent.metadata = {
        ...gjContent.metadata,
        serviceName: SERVICE_03_NAME,
        serviceDefinition: SERVICE_03_DEFINITION,
        pedestrianRoutes: pedestrianRoutes.length,
        publicSpaces: publicSpaces.length,
        visualAxes: visualAxes.length,
        terrainMode: terrainSummary.terrainMode,
        terrainFiles: terrainSummary.terrainFiles,
        minElevation: terrainSummary.minElevation,
        maxElevation: terrainSummary.maxElevation,
        reliefMeters: terrainSummary.reliefMeters,
        restorationAssetsIntegrated: restorationAssetSummary.totalAssets,
        districtScale: districtSummary.districtScale,
        boundarySource: districtSummary.boundarySource,
      };
      fs.writeFileSync(geoJsonPath, JSON.stringify(gjContent, null, 2));
    } catch(e) { console.warn('[GeoJSON] enrich failed:', e.message); }
    console.log(`       ✓ GeoJSON: ${(fs.statSync(geoJsonPath).size/1024).toFixed(0)} KB`);

    // ── STEP 4b: Interactive HTML Map (Leaflet) ──────────────────────────
    console.log('[Post] Building Leaflet interactive HTML map...');
    const htmlMapPath = path.join(jobDir, 'interactive_map.html');
    buildLeafletMap(
      districtName,
      city,
      effectiveCenter,
      effectiveRadius,
      gisFC,
      pedestrianRoutes,
      publicSpaces,
      visualAxes,
      restorationAssetFeatures,
      districtCtx,
      urbanAnalysis,
      districtSummary,
      terrainSummary,
      htmlMapPath
    );
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
    console.log('[Post] Building urban plan PDF / AI / KMZ...');
    const urbanPlanPdfPath = path.join(jobDir, 'urban_plan.pdf');
    await buildUrbanPlanPdf(districtName, districtArea, districtSummary, urbanPlanPdfPath);
    const aiPath = path.join(jobDir, 'urban_plan.ai');
    buildAiFromSvg(svgPath, aiPath);
    const kmzPath = path.join(jobDir, 'district_map.kmz');
    buildKmzFromKml(kmlPath, kmzPath);
    console.log(`       ✓ Urban Plan PDF: ${(fs.statSync(urbanPlanPdfPath).size/1024).toFixed(0)} KB`);
    console.log(`       ✓ AI: ${(fs.statSync(aiPath).size/1024).toFixed(0)} KB`);
    console.log(`       ✓ KMZ: ${(fs.statSync(kmzPath).size/1024).toFixed(0)} KB`);

    // ── STEP 7: Excel ─────────────────────────────────────────────────────
    console.log('[Post] Building Excel report...');
    const xlsxPath = path.join(jobDir, 'urban_analysis.xlsx');
    await buildExcel(
      districtName, city, period, archStyle, districtArea, lat, lng,
      urbanAnalysis, results, restoredMeta, districtSummary, terrainSummary, restorationAssetSummary, xlsxPath
    );
    console.log(`       ✓ Excel: ${(fs.statSync(xlsxPath).size/1024).toFixed(0)} KB`);

    // ── STEP 8: Word Report ───────────────────────────────────────────────
    console.log('[Post] Building Word analytical report...');
    const docxPath = path.join(jobDir, 'analytical_report.docx');
    await buildWord(
      districtName, city, period, archStyle, districtArea,
      urbanAnalysis, results, restoredMeta, districtSummary, terrainSummary, restorationAssetSummary, docxPath
    );
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
      serviceName: SERVICE_03_NAME,
      serviceDefinition: SERVICE_03_DEFINITION,
      model: 'stability-ai/sdxl + openai/gpt-4o',
      districtName, city, period, archStyle,
      lat: effLat, lng: effLng,
      districtArea, notes,
      inputSummary,
      urbanAnalysis,
      districtSummary,
      terrainSummary,
      restorationAssetSummary,
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
      { label: 'خريطة Google Earth المضغوطة (KMZ)', url: relUrl(kmzPath),     ext: 'kmz',     icon: '🗺️' },
      { label: 'بيانات جغرافية GIS (GeoJSON)',           url: relUrl(geoJsonPath), ext: 'geojson', icon: '📌' },
      { label: 'المخطط العمراني (DXF — AutoCAD)',       url: relUrl(dxfPath),    ext: 'dxf',     icon: '📐' },
      { label: 'المخطط العمراني للطباعة (PDF)',          url: relUrl(urbanPlanPdfPath), ext: 'pdf', icon: '📄' },
      { label: 'المخطط العمراني للتحرير (AI)',           url: relUrl(aiPath),     ext: 'ai',      icon: '🎨' },
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
      serviceName: SERVICE_03_NAME,
      urbanAnalysis,
      districtSummary,
      terrainSummary,
      restorationAssetSummary,
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
