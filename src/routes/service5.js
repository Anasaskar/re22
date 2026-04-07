'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

let Replicate;
try {
  Replicate = require('replicate');
} catch (error) {
  Replicate = null;
}

let Document;
let Packer;
let Paragraph;
let TextRun;
let HeadingLevel;
let AlignmentType;
try {
  ({ Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx'));
} catch (error) {
  Document = null;
}

const Job = (() => {
  try {
    return require('../models/Job');
  } catch (error) {
    return null;
  }
})();

const router = express.Router();

const SERVICE_05_NAME = 'Comprehensive 3D Modeling';
const SERVICE_05_DEFINITION = 'Transform architectural rehabilitation outputs, restored heritage assets, and district-scale urban context into structured 3D models for printing, presentation, web viewing, and downstream professional 3D workflows.';

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
const PDF_FONT_REGULAR = 'C:\\Windows\\Fonts\\arial.ttf';
const PDF_FONT_BOLD = 'C:\\Windows\\Fonts\\arialbd.ttf';
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const REPLICATE_3D_PRIMARY_MODEL = process.env.REPLICATE_3D_MODEL || 'tencent/hunyuan-3d-3.1';
const REPLICATE_3D_FALLBACK_MODEL = process.env.REPLICATE_3D_FALLBACK_MODEL || 'tencent/hunyuan3d-2';
const SERVICE_05_SCENE_ANALYSIS_MODEL = process.env.SERVICE_05_SCENE_ANALYSIS_MODEL || 'openai/gpt-4o';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const SERVICE_05_IMAGE_MODEL = process.env.SERVICE_05_IMAGE_MODEL
  || process.env.NANO_BANANA_IMAGE_MODEL
  || 'google/nano-banana-2:b7866a051519a43b5dda3ee54a3013c4813939a18af2b627f8f1dba876efd443';
const replicate = Replicate && REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;

[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.json', '.geojson', '.kml', '.kmz', '.svg', '.dxf',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.txt',
]);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `s5_${Date.now()}_${uuidv4().slice(0, 8)}${path.extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 60 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext || ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

const DETAIL_PROFILES = {
  low: { label: 'Low Poly', windowRows: 1, windowCols: 2, facadeBands: 0, ornamentDepth: 0.08 },
  medium: { label: 'Medium Detail', windowRows: 2, windowCols: 3, facadeBands: 1, ornamentDepth: 0.12 },
  high: { label: 'High Detail', windowRows: 3, windowCols: 4, facadeBands: 2, ornamentDepth: 0.16 },
};

const INTENT_PROFILES = {
  low_poly: { label: 'Low Poly Model', printable: false, webReady: true, targetSceneWidthMm: 180 },
  medium_detail: { label: 'Medium Detail Model', printable: false, webReady: true, targetSceneWidthMm: 200 },
  high_detail: { label: 'High Detail Model', printable: false, webReady: false, targetSceneWidthMm: 220 },
  printing: { label: '3D Printing Model', printable: true, webReady: false, targetSceneWidthMm: 240 },
  presentation: { label: 'Architectural Presentation Model', printable: false, webReady: true, targetSceneWidthMm: 220 },
  vr_web: { label: 'Virtual Reality / Web Visualization Model', printable: false, webReady: true, targetSceneWidthMm: 220 },
};

const STYLE_PALETTES = {
  najdi: { base: '#a36d47', accent: '#d8c2a2', roof: '#7a5033', detail: '#e9d5b5' },
  hejazi: { base: '#e6d8c4', accent: '#8a5f3c', roof: '#ab7f55', detail: '#6a4c32' },
  asiri: { base: '#7d7569', accent: '#c9472f', roof: '#5b544b', detail: '#f0d6a6' },
  ottoman: { base: '#dad7d0', accent: '#6f7e87', roof: '#705a46', detail: '#b99d7a' },
  default: { base: '#c3ab8f', accent: '#70553f', roof: '#8d6e53', detail: '#e3d4be' },
};

const MATERIAL_PROFILES = {
  plaster: { label: 'Plaster', base: '#d7c7b1', accent: '#a89073', roughness: 0.72 },
  stone: { label: 'Stone', base: '#b9aa92', accent: '#8d7964', roughness: 0.84 },
  mud: { label: 'Mud', base: '#b98557', accent: '#8d6039', roughness: 0.88 },
  wood: { label: 'Wood', base: '#7f5b41', accent: '#573c2b', roughness: 0.58 },
};

const RENDER_LIGHTING_PRESETS = {
  daylight: { label: 'Daylight', sunElevation: 42, sunRotation: 128, sunEnergy: 1.0, worldStrength: 0.08, temperature: 1.0, fillEnergy: 80, bloom: false, exposure: -0.9 },
  golden_hour: { label: 'Golden Hour', sunElevation: 14, sunRotation: 116, sunEnergy: 0.82, worldStrength: 0.08, temperature: 0.92, fillEnergy: 65, bloom: false, exposure: -0.55 },
  night: { label: 'Night', sunElevation: -4, sunRotation: 98, sunEnergy: 0.03, worldStrength: 0.03, temperature: 0.72, fillEnergy: 70, bloom: true, exposure: -0.1 },
};

const BLENDER_VIEW_TEMPLATES = [
  { id: 'front_presentation', fileBase: 'front_official', title: 'Front Presentation View', subtitle: 'Balanced frontal architectural presentation', cameraType: 'front', preset: 'daylight', width: 1280, height: 720, focalLength: 52 },
  { id: 'bird_nw', fileBase: 'bird_eye_official', title: 'Bird Eye View', subtitle: 'Architectural bird-eye overview', cameraType: 'bird', preset: 'daylight', width: 1280, height: 720, focalLength: 48 },
  { id: 'bird_alt', fileBase: 'bird_eye_alt_official', title: 'Alternate Bird Eye View', subtitle: 'Golden hour aerial composition', cameraType: 'aerial_alt', preset: 'golden_hour', width: 1280, height: 720, focalLength: 50 },
  { id: 'eye_street', fileBase: 'eye_level_official', title: 'Eye Level View', subtitle: 'Architectural eye-level perspective', cameraType: 'eye', preset: 'golden_hour', width: 1280, height: 720, focalLength: 58 },
  { id: 'corner', fileBase: 'corner_official', title: 'Corner Perspective', subtitle: 'Corner massing and facade presentation', cameraType: 'corner', preset: 'daylight', width: 1280, height: 720, focalLength: 52 },
  { id: 'night_facade', fileBase: 'night_official', title: 'Night Facade View', subtitle: 'Night presentation facade render', cameraType: 'night', preset: 'night', width: 1280, height: 720, focalLength: 60 },
];

const NANO_BANANA_BASE_PROMPT = 'Generate a high-quality architectural presentation image of this heritage building or heritage context while preserving the original architectural identity, proportions, massing, facade language, and heritage style. Keep the building visually faithful to the provided reference outputs. Do not redesign the architecture, do not add extra floors, do not change the overall structure, and do not invent unrelated buildings or background architecture. Improve realism, facade articulation, materials, lighting, depth, and presentation quality. Use elegant heritage-appropriate materials such as plaster, stone, mud, and wood where relevant. Add subtle and realistic context such as palms, planters, soft greenery, and minimal human presence where appropriate. The result should look like a refined professional architectural visualization, not a raw 3D preview.';

const ANGLE_SPECIFIC_PROMPTS = {
  front: 'This is a front architectural presentation view. Preserve the main front facade composition, frontal perspective, entrance emphasis, and principal architectural identity. Do not turn this into an aerial, side, rear, or interior image.',
  rear: 'This is a rear architectural presentation view. Preserve the back-side composition and keep it visibly less ceremonial than the front facade. Do not turn this into another front facade.',
  left: 'This is a left-side architectural presentation view. Preserve the left-side building elevation, side massing, side openings, and true side perspective. Do not turn this into a front or aerial view.',
  right: 'This is a right-side architectural presentation view. Preserve the right-side building elevation, side massing, side openings, and true side perspective. Do not turn this into a front or aerial view.',
  bird: 'This is a bird’s-eye architectural presentation view. Preserve the elevated perspective, visible roofscape, upper-level composition, and overall building/site massing. Do not turn this into a front facade or interior.',
  bird_alt: 'This is an alternate bird’s-eye architectural presentation view from a different elevated angle. Preserve the building massing, roofscape, and context while keeping the perspective clearly aerial.',
  eye: 'This is a street-level architectural presentation view. Preserve the eye-level perspective, facade readability, and realistic human-scale architectural composition.',
  corner: 'This is a corner perspective architectural presentation view. Preserve the angled composition showing two sides of the building with clear depth and architectural form.',
  night: 'This is a night architectural presentation view. Preserve the same building and composition while transforming the scene into a refined night render with warm architectural lighting, believable shadows, and presentation-quality atmosphere.',
};

const STYLE_EXTENSION_PROMPTS = {
  najdi: 'Emphasize mud-brick character, geometric openings, thick walls, and restrained traditional detailing.',
  hejazi: 'Emphasize roshan-inspired woodwork, urban heritage facade articulation, and refined decorative screens.',
  aseeri: 'Emphasize regional material identity, painted or stone character, and mountain-context heritage expression.',
  contemporary_heritage: 'Preserve traditional references while adding refined contemporary presentation quality.',
};

const VIEW_PROMPT_MAP = {
  front_presentation: 'front',
  rear_presentation: 'rear',
  left_side: 'left',
  right_side: 'right',
  bird_nw: 'bird',
  bird_alt: 'bird_alt',
  eye_street: 'eye',
  corner: 'corner',
  night_facade: 'night',
};

const VIEW_REFERENCE_BUCKETS = {
  front_presentation: ['front', 'street', 'detail'],
  rear_presentation: ['rear', 'detail'],
  left_side: ['left', 'detail'],
  right_side: ['right', 'detail'],
  bird_nw: ['aerial', 'floorplan', 'front'],
  bird_alt: ['aerial', 'floorplan', 'left', 'right'],
  eye_street: ['front', 'street', 'detail'],
  corner: ['front', 'left', 'right', 'detail'],
  night_facade: ['night', 'front', 'street', 'detail'],
};

function resolveAppBaseUrl(req) {
  const configured = normalizeText(process.env.APP_BASE_URL);
  if (configured) return configured.replace(/\/+$/, '');

  const forwardedProto = normalizeText(req.get('x-forwarded-proto'));
  const forwardedHost = normalizeText(req.get('x-forwarded-host'));
  const host = forwardedHost || normalizeText(req.get('host'));
  const proto = forwardedProto || normalizeText(req.protocol, 'http');

  if (host) {
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  return APP_BASE_URL.replace(/\/+$/, '');
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function normalizeText(value, fallback = '') {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFloat(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsvList(value) {
  return normalizeText(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function relOutputUrl(jobId, filePath) {
  return `/outputs/${jobId}/${path.basename(filePath)}`;
}

function publicPathFromUrl(urlPath) {
  return path.join(__dirname, '../../public', String(urlPath || '').replace(/^\/+/, ''));
}

function setPdfFont(doc, bold = false) {
  const fontPath = bold ? PDF_FONT_BOLD : PDF_FONT_REGULAR;
  if (fs.existsSync(fontPath)) {
    return doc.font(fontPath);
  }
  return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
}

function fileExt(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isImageExtension(ext) {
  return ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp'].includes(ext);
}

function compactText(value, maxLength = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function slugify(value, fallback = 'model') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

function fileToDataUri(filePath) {
  const ext = fileExt(filePath);
  const mime = ext === '.png'
    ? 'image/png'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = String(url || '').startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, res => {
      if (res.statusCode && res.statusCode >= 400) {
        file.close(() => fs.unlink(dest, () => {}));
        return reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', error => {
      file.close(() => fs.unlink(dest, () => {}));
      reject(error);
    });
  });
}

function hexToRgb01(hex) {
  const normalized = String(hex || '#b99d7a').replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(ch => ch + ch).join('')
    : normalized.padStart(6, '0').slice(0, 6);
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

function colorFromStyle(style) {
  const key = normalizeText(style).toLowerCase();
  if (key.includes('najd')) return STYLE_PALETTES.najdi;
  if (key.includes('hejaz') || key.includes('hijaz') || key.includes('hejazi')) return STYLE_PALETTES.hejazi;
  if (key.includes('asir')) return STYLE_PALETTES.asiri;
  if (key.includes('ottoman')) return STYLE_PALETTES.ottoman;
  return STYLE_PALETTES.default;
}

function materialProfileFromStyle(style) {
  const key = normalizeText(style).toLowerCase();
  if (key.includes('najd') || key.includes('mud') || key.includes('adobe')) return MATERIAL_PROFILES.mud;
  if (key.includes('hejaz') || key.includes('hejazi') || key.includes('wood')) return MATERIAL_PROFILES.wood;
  if (key.includes('ottoman') || key.includes('stone')) return MATERIAL_PROFILES.stone;
  if (key.includes('asir') || key.includes('plaster')) return MATERIAL_PROFILES.plaster;
  return MATERIAL_PROFILES.plaster;
}

function getBlenderPath() {
  // Normalize env var: if it points to a directory, append blender.exe
  let envPath = process.env.BLENDER_PATH || '';
  if (envPath && !envPath.toLowerCase().endsWith('.exe')) {
    envPath = path.join(envPath, 'blender.exe');
  }

  const candidates = [
    envPath,
    'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe',
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function getHeadlessBrowserPath() {
  const candidates = [
    process.env.BROWSER_CAPTURE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);

  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function canUseReplicate3D() {
  return Boolean(replicate);
}

function get3DPolycount(detailLevel, modelIntent) {
  if (modelIntent === 'printing') return 50000;
  if (detailLevel === 'low') return 8000;
  if (detailLevel === 'high') return 60000;
  return 25000;
}

function buildReplicate3DGenerationConfig(building, context) {
  const lowPoly = context.modeling.detailLevel === 'low' || context.modeling.modelIntent === 'low_poly';
  const printing = context.modeling.modelIntent === 'printing';

  return {
    target_polycount: get3DPolycount(context.modeling.detailLevel, context.modeling.modelIntent),
    enable_texture: !printing,
    texture_prompt: printing
      ? 'clean fabrication-ready material separation, neutral clay finish, no environment'
      : `architectural heritage materials, ${building.style}, clean facade textures, preserved historic identity`,
    geometry_mode: lowPoly ? 'lowpoly' : 'default',
    printable: printing,
  };
}

function getBuildingReferenceImages(building, context) {
  const serviceJob = context.linkedServices.service2Jobs.find(job => job.jobId === building.sourceJobId);
  const jobImages = getPrioritizedService2Images(serviceJob, 6);
  if (jobImages.length) return jobImages.slice(0, 4);
  return (context.representativeImages || [])
    .map(item => item.path)
    .filter(fs.existsSync)
    .slice(0, 4);
}

function buildReplicate3DPrompt(building, context) {
  // If user provided a prompt override, use it directly
  if (context?.promptOverride) return compactText(context.promptOverride, 900);

  const heritageElements = (building.styleElements || []).slice(0, 8).join(', ');
  const spatialContext = getSpatialContext(context);
  const districtContext = spatialContext
    ? `${spatialContext.districtName || 'historic district'} ${spatialContext.city ? `in ${spatialContext.city}` : ''}`
    : context.project.location || 'historic urban context';
  const viewInfo = [];
  if (building.sourceViews?.front?.length) viewInfo.push('front facade reference');
  if (building.sourceViews?.rear?.length) viewInfo.push('rear facade reference');
  if ((building.sourceViews?.left?.length || 0) + (building.sourceViews?.right?.length || 0)) viewInfo.push('side facade references');
  if (building.sourceViews?.aerial?.length) viewInfo.push('aerial roof reference');
  if (building.sourceViews?.floorplan?.length) viewInfo.push('floor-plan reference');
  const guidance = building.modelingGuidance || {};

  return compactText(
    `Architectural heritage 3D model of ${building.name}, a ${building.floors}-story ${building.buildingType} in ${districtContext}. Preserve ${building.style} identity with ${heritageElements || 'arches, windows, doors, facade bands, parapets'}. Use the supplied ${viewInfo.join(', ') || 'architectural reference views'} to keep the real massing, facade rhythm, roof logic, and heritage proportions faithful to the source. Generate articulated facade depth, readable openings, parapets, roof variation, and professional editable geometry suitable for ${context.modeling.intentProfile.label}. Target facade complexity ${Math.round((guidance.facadeComplexity || 0.45) * 100)} out of 100 while avoiding generic block massing.`,
    900
  );
}

function buildReplicateAttemptInputs(building, context) {
  const images = getBuildingReferenceImages(building, context);
  const imageUris = images.map(fileToDataUri);
  const config = buildReplicate3DGenerationConfig(building, context);
  const prompt = buildReplicate3DPrompt(building, context);
  const attempts = [];

  if (imageUris.length > 1) {
    attempts.push({
      model: REPLICATE_3D_PRIMARY_MODEL,
      label: 'primary-images',
      input: {
        images: imageUris,
        texture: config.enable_texture,
        target_polycount: config.target_polycount,
      },
    });
  }

  if (imageUris.length) {
    attempts.push({
      model: REPLICATE_3D_PRIMARY_MODEL,
      label: 'primary-image',
      input: {
        image: imageUris[0],
        texture: config.enable_texture,
        target_polycount: config.target_polycount,
        remove_background: true,
      },
    });
  }

  attempts.push({
    model: REPLICATE_3D_PRIMARY_MODEL,
    label: 'primary-text',
    input: {
      prompt,
      texture: config.enable_texture,
      target_polycount: config.target_polycount,
    },
  });

  if (imageUris.length) {
    attempts.push({
      model: REPLICATE_3D_FALLBACK_MODEL,
      label: 'fallback-image',
      input: {
        image: imageUris[0],
        remove_background: true,
      },
    });
  }

  attempts.push({
    model: REPLICATE_3D_FALLBACK_MODEL,
    label: 'fallback-text',
    input: { prompt },
  });

  return attempts;
}

async function runReplicate3DWorkflow(building, context) {
  const attempts = buildReplicateAttemptInputs(building, context);
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const output = await replicate.run(attempt.model, { input: attempt.input });
      return {
        output,
        model: attempt.model,
        attemptLabel: attempt.label,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Replicate 3D generation failed for ${building.name}.`);
}

function collectHttpUrls(value, urls = []) {
  if (!value) return urls;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectHttpUrls(item, urls));
    return urls;
  }
  if (typeof value === 'object') {
    if (typeof value.url === 'function') {
      try {
        const produced = value.url();
        if (/^https?:\/\//i.test(produced)) urls.push(produced);
      } catch (error) {
        // Ignore best-effort extraction failures.
      }
    }
    const asString = String(value);
    if (/^https?:\/\//i.test(asString)) urls.push(asString);
    Object.values(value).forEach(item => collectHttpUrls(item, urls));
  }
  return urls;
}

function classifyReplicate3DUrls(urls = []) {
  const classified = [];
  for (const url of urls) {
    const pathname = new URL(url).pathname.toLowerCase();
    const ext = fileExt(pathname).slice(1);
    if (!ext) continue;
    classified.push({ ext, url });
  }
  return classified;
}

function parseObjGeometry(objText) {
  const vertices = [];
  const faces = [];

  for (const rawLine of String(objText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/);
      vertices.push([Number(x), Number(z), Number(y)]);
      continue;
    }
    if (line.startsWith('f ')) {
      const refs = line.split(/\s+/).slice(1).map(item => parseInt(item.split('/')[0], 10) - 1).filter(index => index >= 0);
      for (let i = 1; i < refs.length - 1; i += 1) {
        faces.push([refs[0], refs[i], refs[i + 1]]);
      }
    }
  }

  return { vertices, faces };
}

async function convertObjUrlToStl(objUrl, stlPath, solidName) {
  if (!objUrl) return false;
  const objText = await new Promise((resolve, reject) => {
    const proto = String(objUrl).startsWith('https') ? https : http;
    proto.get(objUrl, response => {
      if ((response.statusCode || 500) >= 400) {
        return reject(new Error(`OBJ download failed (${response.statusCode})`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });

  const geometry = parseObjGeometry(objText);
  if (!geometry.vertices.length || !geometry.faces.length) return false;
  writeStl({ name: solidName, vertices: geometry.vertices, faces: geometry.faces }, stlPath);
  return true;
}

async function buildReplicateAssets(jobId, jobDir, context) {
  if (!canUseReplicate3D()) return { assets: [], warnings: [] };

  const assets = [];
  const warnings = [];

  for (const building of context.targetBuildings) {
    try {
      const generation = await runReplicate3DWorkflow(building, context);
      const base = slugify(`${building.name}_replicate`, building.id);
      const files = [];
      const urls = [...new Set(collectHttpUrls(generation.output))];
      const downloadSpec = classifyReplicate3DUrls(urls)
        .filter(item => ['glb', 'fbx', 'obj', 'stl'].includes(item.ext));

      for (const item of downloadSpec) {
        const targetPath = path.join(jobDir, `${base}.${item.ext}`);
        await downloadFile(item.url, targetPath);
        files.push({
          ext: item.ext,
          path: targetPath,
          url: relOutputUrl(jobId, targetPath),
          label: `${building.name} (${item.ext.toUpperCase()})`,
        });
      }

      const stlPath = path.join(jobDir, `${base}.stl`);
      const objFile = files.find(file => file.ext === 'obj');
      if (objFile && !files.find(file => file.ext === 'stl') && await convertObjUrlToStl(objFile.url, stlPath, building.name)) {
        files.push({
          ext: 'stl',
          path: stlPath,
          url: relOutputUrl(jobId, stlPath),
          label: `${building.name} (STL)`,
        });
      }

      const thumbnailUrl = classifyReplicate3DUrls(urls).find(item => ['png', 'jpg', 'jpeg', 'webp'].includes(item.ext))?.url || '';
      let thumbnailPath = '';
      if (thumbnailUrl) {
        thumbnailPath = path.join(jobDir, `${base}_thumbnail${fileExt(thumbnailUrl) || '.png'}`);
        try {
          await downloadFile(thumbnailUrl, thumbnailPath);
        } catch (error) {
          thumbnailPath = '';
        }
      }

      if (!files.length) {
        warnings.push(`Replicate completed for ${building.name} but no downloadable model files were returned.`);
        continue;
      }

      assets.push({
        buildingId: building.id,
        buildingName: building.name,
        provider: 'replicate',
        model: generation.model,
        attemptLabel: generation.attemptLabel,
        glbPath: files.find(file => file.ext === 'glb')?.path || '',
        files,
        thumbnailPath,
      });
    } catch (error) {
      warnings.push(`Replicate generation failed for ${building.name}: ${error.message}`);
    }
  }

  return { assets, warnings };
}

function listOutputJobDirectories() {
  if (!fs.existsSync(OUTPUTS_DIR)) return [];
  return fs.readdirSync(OUTPUTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

function buildJobCatalogEntry(jobId, meta = {}) {
  const title = normalizeText(meta.buildingName)
    || normalizeText(meta.districtName)
    || normalizeText(meta.serviceName)
    || `Service ${meta.service || '?'} job`;

  const subtitleParts = [];
  if (meta.style) subtitleParts.push(meta.style);
  if (meta.buildingType) subtitleParts.push(meta.buildingType);
  if (meta.city) subtitleParts.push(meta.city);
  if (meta.period) subtitleParts.push(meta.period);
  if (meta.viewsGenerated) subtitleParts.push(`${meta.viewsGenerated} views`);

  return {
    jobId,
    service: meta.service || null,
    serviceName: meta.serviceName || `Service ${meta.service || '?'}`,
    title,
    subtitle: subtitleParts.join(' | '),
    processedAt: meta.processedAt || meta.generatedAt || '',
  };
}

function discoverPreviousJobs() {
  const jobs = [];
  for (const jobId of listOutputJobDirectories()) {
    const metaPath = path.join(OUTPUTS_DIR, jobId, 'metadata.json');
    const meta = safeReadJson(metaPath);
    if (!meta || ![2, 3].includes(meta.service)) continue;
    jobs.push(buildJobCatalogEntry(jobId, meta));
  }

  jobs.sort((a, b) => new Date(b.processedAt || 0) - new Date(a.processedAt || 0));
  return jobs;
}

function collectOutputFiles(jobDir) {
  if (!fs.existsSync(jobDir)) return [];
  return fs.readdirSync(jobDir).map(name => {
    const fullPath = path.join(jobDir, name);
    const stat = fs.statSync(fullPath);
    return {
      name,
      path: fullPath,
      ext: fileExt(name).slice(1),
      sizeKB: Math.round(stat.size / 1024),
      isImage: isImageExtension(fileExt(name)),
    };
  });
}

function getRepresentativeImagePaths(meta, jobDir) {
  const imagePaths = [];

  if (Array.isArray(meta.outputFiles)) {
    for (const file of meta.outputFiles) {
      const ext = `.${String(file.ext || '').toLowerCase()}`;
      if (!isImageExtension(ext)) continue;
      const local = publicPathFromUrl(file.url);
      if (fs.existsSync(local)) imagePaths.push(local);
    }
  }

  if (!imagePaths.length) {
    for (const file of collectOutputFiles(jobDir)) {
      if (file.isImage) imagePaths.push(file.path);
    }
  }

  return [...new Set(imagePaths)].slice(0, 10);
}

function inferService2ViewType(value = '') {
  const text = String(value || '').toLowerCase();
  if (text.includes('floorplan') || text.includes('floor_plan') || text.includes('plan')) return 'floorplan';
  if (text.includes('aerial') || text.includes('bird') || text.includes('drone')) return 'aerial';
  if (text.includes('rear') || text.includes('back')) return 'rear';
  if (text.includes('left')) return 'left';
  if (text.includes('right')) return 'right';
  if (text.includes('interior') || text.includes('courtyard') || text.includes('atrium')) return 'interior';
  if (text.includes('night')) return 'night';
  if (text.includes('street')) return 'street';
  if (text.includes('detail')) return 'detail';
  if (text.includes('section')) return 'sectional';
  if (text.includes('front') || text.includes('entrance') || text.includes('facade')) return 'front';
  return 'unknown';
}

function buildService2ViewBuckets(meta = {}, jobDir) {
  const buckets = {
    front: [], rear: [], left: [], right: [], aerial: [],
    interior: [], floorplan: [], night: [], street: [], detail: [], sectional: [], unknown: [],
  };

  const candidates = [];
  for (const file of meta.outputFiles || []) {
    const local = publicPathFromUrl(file.url);
    candidates.push({
      label: `${file.label || ''} ${path.basename(file.url || '')}`.trim(),
      url: file.url || '',
      path: fs.existsSync(local) ? local : '',
    });
  }
  for (const file of collectOutputFiles(jobDir)) {
    if (!file.isImage) continue;
    candidates.push({
      label: file.name,
      url: '',
      path: file.path,
    });
  }

  for (const candidate of candidates) {
    const type = inferService2ViewType(candidate.label);
    buckets[type].push(candidate);
  }

  Object.keys(buckets).forEach(key => {
    buckets[key] = buckets[key].filter((item, index, arr) =>
      arr.findIndex(other => (other.path || other.label) === (item.path || item.label)) === index
    );
  });
  return buckets;
}

function buildService2Guidance(styleAnalysis = {}, viewBuckets = {}) {
  const elements = (styleAnalysis.elements || []).map(item => String(item).toLowerCase());
  const multiFacadeCoverage = ['front', 'rear', 'left', 'right'].reduce((sum, key) => sum + (viewBuckets[key]?.length ? 1 : 0), 0);
  const facadeComplexity = clamp(
    0.35
      + multiFacadeCoverage * 0.14
      + (viewBuckets.detail?.length ? 0.18 : 0)
      + (elements.includes('arches') ? 0.08 : 0)
      + (elements.some(item => item.includes('balcon')) ? 0.08 : 0),
    0.35,
    0.92
  );

  return {
    hasFront: Boolean(viewBuckets.front?.length),
    hasRear: Boolean(viewBuckets.rear?.length),
    hasSideViews: Boolean((viewBuckets.left?.length || 0) + (viewBuckets.right?.length || 0)),
    hasAerial: Boolean(viewBuckets.aerial?.length),
    hasInterior: Boolean(viewBuckets.interior?.length),
    hasFloorPlan: Boolean(viewBuckets.floorplan?.length),
    hasNight: Boolean(viewBuckets.night?.length),
    hasStreet: Boolean(viewBuckets.street?.length),
    multiFacadeCoverage,
    facadeComplexity,
    courtyardLikelihood: clamp((viewBuckets.floorplan?.length ? 0.36 : 0.1) + (viewBuckets.aerial?.length ? 0.18 : 0), 0.08, 0.68),
    roofArticulation: clamp((viewBuckets.aerial?.length ? 0.38 : 0.12) + (elements.includes('parapets') ? 0.1 : 0), 0.12, 0.8),
    asymmetry: clamp((viewBuckets.left?.length && viewBuckets.right?.length ? 0.16 : 0.28) + (viewBuckets.rear?.length ? 0.12 : 0), 0.12, 0.52),
    facadeDepth: clamp(0.18 + facadeComplexity * 0.34 + (viewBuckets.detail?.length ? 0.12 : 0), 0.18, 0.58),
    openingDepth: clamp(0.12 + facadeComplexity * 0.22, 0.12, 0.4),
  };
}

function buildService3Guidance(meta = {}) {
  const terrain = meta.terrainSummary || {};
  const district = meta.districtSummary || {};
  const urban = meta.urbanAnalysis || {};
  return {
    terrainReliefBias: terrain.reliefMeters ? clamp(normalizeFloat(terrain.reliefMeters, 6) / 35, 0.12, 0.8) : 0.18,
    streetCount: normalizeInteger(district.streetCount, 0),
    publicSpaceCount: normalizeInteger(district.publicSpaceCount, 0),
    openSpaceCount: normalizeInteger(district.openSpaceCount, 0),
    buildingCount: normalizeInteger(district.buildingCount, 0),
    urbanPattern: normalizeText(urban.urbanPattern, 'Organic'),
    style: normalizeText(urban.detectedStyle, ''),
    keyFeatures: urban.keyFeatures || [],
  };
}

function getPrioritizedService2Images(job, limit = 6) {
  if (!job) return [];
  const chosen = [];
  const seen = new Set();
  const priorityOrder = ['front', 'rear', 'left', 'right', 'aerial', 'floorplan', 'street', 'detail', 'interior', 'night'];

  for (const key of priorityOrder) {
    for (const item of job.viewBuckets?.[key] || []) {
      const imagePath = item.path;
      if (!imagePath || !fs.existsSync(imagePath) || seen.has(imagePath)) continue;
      seen.add(imagePath);
      chosen.push(imagePath);
      if (chosen.length >= limit) return chosen;
    }
  }

  for (const imagePath of job.representativeImages || []) {
    if (!imagePath || !fs.existsSync(imagePath) || seen.has(imagePath)) continue;
    seen.add(imagePath);
    chosen.push(imagePath);
    if (chosen.length >= limit) break;
  }

  return chosen;
}

function summarizeService2Influence(service2Jobs = []) {
  const coverage = {
    front: 0,
    rear: 0,
    left: 0,
    right: 0,
    aerial: 0,
    floorplan: 0,
    interior: 0,
    detail: 0,
    street: 0,
    night: 0,
  };

  for (const job of service2Jobs) {
    Object.keys(coverage).forEach(key => {
      coverage[key] += job.viewBuckets?.[key]?.length || 0;
    });
  }

  return {
    linkedBuildings: service2Jobs.length,
    guidedBuildings: service2Jobs.filter(job => (job.modelingGuidance?.multiFacadeCoverage || 0) >= 2).length,
    coverage,
  };
}

function buildContextInfluenceSummary(context) {
  const service2 = summarizeService2Influence(context.linkedServices.service2Jobs || []);
  const service3 = context.linkedServices.service3;
  const uploadedSceneContext = context.linkedServices.uploadedSceneContext;
  const spatialContext = getSpatialContext(context);
  return {
    generationMode: context.modeling.generationMode,
    service2,
    service3: spatialContext ? {
      linked: true,
      inferredFromUploads: !service3 && Boolean(uploadedSceneContext),
      districtName: spatialContext.districtName || '',
      urbanPattern: spatialContext.spatialGuidance?.urbanPattern || '',
      terrainReliefBias: spatialContext.spatialGuidance?.terrainReliefBias || 0,
      streetCount: spatialContext.spatialGuidance?.streetCount || 0,
      publicSpaceCount: spatialContext.spatialGuidance?.publicSpaceCount || 0,
      openSpaceCount: spatialContext.spatialGuidance?.openSpaceCount || 0,
      buildingCount: spatialContext.spatialGuidance?.buildingCount || 0,
    } : { linked: false },
    uploadedScene: uploadedSceneContext ? {
      linked: true,
      scope: uploadedSceneContext.analysis?.scope || 'building',
      buildingCount: uploadedSceneContext.analysis?.buildingCount || 1,
      reason: uploadedSceneContext.analysis?.reason || '',
    } : { linked: false },
  };
}

function getAngleSpecificPrompt(viewId) {
  return ANGLE_SPECIFIC_PROMPTS[VIEW_PROMPT_MAP[viewId] || 'corner'] || ANGLE_SPECIFIC_PROMPTS.corner;
}

function getStylePromptExtension(style) {
  const key = normalizeText(style).toLowerCase();
  if (key.includes('najd')) return STYLE_EXTENSION_PROMPTS.najdi;
  if (key.includes('hejaz') || key.includes('hejazi') || key.includes('hijaz')) return STYLE_EXTENSION_PROMPTS.hejazi;
  if (key.includes('asir') || key.includes('aseer') || key.includes('aseeri')) return STYLE_EXTENSION_PROMPTS.aseeri;
  if (key.includes('contemporary')) return STYLE_EXTENSION_PROMPTS.contemporary_heritage;
  return '';
}

function collectService3ReferenceImages(service3, limit = 3) {
  if (!service3) return [];
  return (service3.representativeImages || [])
    .filter(filePath => filePath && fs.existsSync(filePath))
    .slice(0, limit);
}

function collectNanoBananaReferenceImages(context, view, rawGuidePath = '') {
  const selected = [];
  const seen = new Set();
  const buckets = VIEW_REFERENCE_BUCKETS[view.id] || ['front', 'detail'];

  for (const job of context.linkedServices.service2Jobs || []) {
    for (const bucket of buckets) {
      for (const item of job.viewBuckets?.[bucket] || []) {
        const imagePath = item.path;
        if (!imagePath || !fs.existsSync(imagePath) || seen.has(imagePath)) continue;
        seen.add(imagePath);
        selected.push(imagePath);
        if (selected.length >= 6) break;
      }
      if (selected.length >= 6) break;
    }
    if (selected.length >= 6) break;
  }

  const spatialContext = getSpatialContext(context);
  if (selected.length < 6 && spatialContext && ['bird_nw', 'bird_alt', 'night_facade'].includes(view.id)) {
    for (const imagePath of collectService3ReferenceImages(spatialContext, 3)) {
      if (seen.has(imagePath)) continue;
      seen.add(imagePath);
      selected.push(imagePath);
      if (selected.length >= 6) break;
    }
  }

  if (selected.length < 6) {
    for (const imagePath of (context.representativeImages || []).map(item => item.path).filter(Boolean)) {
      if (!fs.existsSync(imagePath) || seen.has(imagePath)) continue;
      seen.add(imagePath);
      selected.push(imagePath);
      if (selected.length >= 6) break;
    }
  }

  if (rawGuidePath && fs.existsSync(rawGuidePath) && !seen.has(rawGuidePath)) {
    selected.push(rawGuidePath);
  }

  return selected.slice(0, 8);
}

function buildNanoBananaPrompt(context, view, referencePaths = []) {
  const promptParts = [
    NANO_BANANA_BASE_PROMPT,
    getAngleSpecificPrompt(view.id),
  ];

  const stylePrompt = getStylePromptExtension(context.project.architecturalStyle || context.targetBuildings[0]?.style);
  if (stylePrompt) promptParts.push(stylePrompt);

  promptParts.push(`Project context: ${context.project.title}. Preserve the identity of ${context.project.buildingName || context.targetBuildings[0]?.name || 'the heritage building'}.`);

  if (referencePaths.length) {
    promptParts.push('Treat the provided Service 02 and Service 03 references as the primary visual truth. Use any structural guidance image only to preserve angle, silhouette, and composition.');
  }

  if (getSpatialContext(context) && ['bird_nw', 'bird_alt', 'night_facade'].includes(view.id)) {
    promptParts.push('Where urban context or terrain references are provided, use them to keep terrain, streets, open spaces, and district relationships faithful without inventing unrelated buildings.');
  }

  return compactText(promptParts.filter(Boolean).join('\n\n'), 5000);
}

function summarizeService2(meta = {}, jobDir) {
  const styleAnalysis = meta.styleAnalysis || {};
  const viewBuckets = buildService2ViewBuckets(meta, jobDir);
  return {
    jobId: meta.jobId || path.basename(jobDir),
    service: 2,
    serviceName: meta.serviceName || 'Architectural Rehabilitation Visualization',
    buildingName: meta.buildingName || '',
    style: meta.style || '',
    buildingType: meta.buildingType || '',
    area: meta.area || '',
    floors: meta.floors || '',
    viewsGenerated: meta.viewsGenerated || 0,
    styleAnalysis: {
      detectedStyle: styleAnalysis.detectedStyle || '',
      elements: styleAnalysis.elements || [],
      heritageValue: styleAnalysis.heritageValue || '',
      notes: styleAnalysis.notes || '',
      reuseGuidance: styleAnalysis.reuseGuidance || '',
    },
    viewBuckets,
    modelingGuidance: buildService2Guidance(styleAnalysis, viewBuckets),
    processedAt: meta.processedAt || '',
    representativeImages: getRepresentativeImagePaths(meta, jobDir),
  };
}

function summarizeService3(meta = {}, jobDir) {
  const urbanAnalysis = meta.urbanAnalysis || {};
  return {
    jobId: meta.jobId || path.basename(jobDir),
    service: 3,
    serviceName: meta.serviceName || 'Geospatial Analysis & Urban Fabric Restoration',
    districtName: meta.districtName || '',
    city: meta.city || '',
    period: meta.period || '',
    districtArea: meta.districtArea || '',
    districtSummary: meta.districtSummary || {},
    terrainSummary: meta.terrainSummary || {},
    restorationAssetSummary: meta.restorationAssetSummary || {},
    urbanAnalysis: {
      detectedStyle: urbanAnalysis.detectedStyle || '',
      urbanPattern: urbanAnalysis.urbanPattern || '',
      keyFeatures: urbanAnalysis.keyFeatures || [],
      heritageValue: urbanAnalysis.heritageValue || '',
      restorationNotes: urbanAnalysis.restorationNotes || '',
    },
    spatialGuidance: buildService3Guidance(meta),
    processedAt: meta.processedAt || '',
    representativeImages: getRepresentativeImagePaths(meta, jobDir),
  };
}

function summarizeUploadedFiles(files = []) {
  const parsedMetadata = [];
  const items = files.map(file => {
    const ext = fileExt(file.originalname || file.path);
    if (ext === '.json') {
      const parsed = safeReadJson(file.path);
      if (parsed && [2, 3].includes(parsed.service)) {
        parsedMetadata.push(parsed);
      }
    }

    let category = 'document';
    if (isImageExtension(ext)) category = 'image';
    if (['.glb', '.gltf', '.fbx', '.obj', '.stl'].includes(ext)) category = 'model';
    if (['.geojson', '.json', '.kml', '.kmz', '.dxf', '.svg'].includes(ext)) category = 'data';

    return {
      originalName: file.originalname,
      storedPath: file.path,
      ext: ext.slice(1),
      sizeKB: Math.round((file.size || 0) / 1024),
      category,
    };
  });

  return {
    totalFiles: items.length,
    images: items.filter(item => item.category === 'image').length,
    models: items.filter(item => item.category === 'model').length,
    documents: items.filter(item => item.category === 'document').length,
    dataFiles: items.filter(item => item.category === 'data').length,
    items,
    parsedMetadata,
  };
}

function loadJobContext(jobId, expectedService = null) {
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  const metaPath = path.join(jobDir, 'metadata.json');
  const meta = safeReadJson(metaPath);

  if (!meta) {
    throw new Error(`Job "${jobId}" does not contain readable metadata.`);
  }

  if (expectedService && meta.service !== expectedService) {
    throw new Error(`Job "${jobId}" is Service ${meta.service}, not Service ${expectedService}.`);
  }

  if (meta.service === 2) return summarizeService2(meta, jobDir);
  if (meta.service === 3) return summarizeService3(meta, jobDir);
  throw new Error(`Job "${jobId}" is not a Service 02/03 output.`);
}

function dedupeByJobId(items = []) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.service}:${item.jobId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickRepresentativeImages(linkedJobs, uploadedFilesSummary, limit = 8) {
  const images = [];

  for (const job of linkedJobs) {
    for (const imagePath of job.representativeImages || []) {
      if (fs.existsSync(imagePath)) {
        images.push({ path: imagePath, source: job.serviceName });
      }
      if (images.length >= limit) break;
    }
    if (images.length >= limit) break;
  }

  if (images.length < limit) {
    for (const file of uploadedFilesSummary.items || []) {
      if (file.category === 'image' && fs.existsSync(file.storedPath)) {
        images.push({ path: file.storedPath, source: 'Uploaded file' });
      }
      if (images.length >= limit) break;
    }
  }

  return images.slice(0, limit);
}

function buildBuildingSpec(job, detailLevel, modelIntent, index) {
  const area = Math.max(normalizeFloat(job.area, 320), 180);
  const floors = Math.max(normalizeInteger(job.floors, 2), 1);
  const footprintArea = Math.max(area / floors, 120);
  const guidance = job.modelingGuidance || {};
  const footprintBias = guidance.hasFloorPlan ? 1.12 : guidance.hasAerial ? 1.02 : 0.94;
  const width = Math.max(Math.sqrt(footprintArea * (1.15 + footprintBias * 0.28)), 10);
  const depth = Math.max((footprintArea / width) * (guidance.hasFloorPlan ? 1.08 : 1), 8);
  const printable = INTENT_PROFILES[modelIntent]?.printable;
  const elements = (job.styleAnalysis?.elements || []).map(item => String(item).toLowerCase());
  const roofType = guidance.hasAerial
    ? (guidance.hasFloorPlan ? 'courtyard_ring' : 'stepped_roof')
    : (elements.includes('courtyard') ? 'courtyard_u' : 'articulated_flat');

  return {
    id: slugify(job.buildingName || `building_${index + 1}`),
    name: normalizeText(job.buildingName, `Heritage Building ${index + 1}`),
    style: normalizeText(job.styleAnalysis?.detectedStyle || job.style, 'Traditional heritage'),
    buildingType: normalizeText(job.buildingType, 'Adaptive reuse building'),
    area,
    floors,
    width,
    depth,
    height: floors * 3.9,
    wallThickness: printable ? 1.2 : 0.35,
    styleElements: job.styleAnalysis?.elements || [],
    heritageValue: job.styleAnalysis?.heritageValue || '',
    notes: job.styleAnalysis?.notes || '',
    palette: colorFromStyle(job.styleAnalysis?.detectedStyle || job.style),
    detailLevel,
    sourceJobId: job.jobId,
    generationMode: 'guided-building',
    sourceViews: job.viewBuckets || {},
    modelingGuidance: guidance,
    roofType,
    facadeDepthFactor: guidance.facadeDepth || 0.22,
    openingDepthFactor: guidance.openingDepth || 0.16,
    courtyardRatio: guidance.courtyardLikelihood || 0.16,
    massingVariation: guidance.facadeComplexity || 0.42,
    sideArticulation: guidance.hasSideViews ? 0.34 : 0.16,
    asymmetry: guidance.asymmetry || 0.24,
  };
}

function buildFallbackBuildingSpec(input, detailLevel, modelIntent) {
  const floors = Math.max(normalizeInteger(input.floors, 2), 1);
  const area = Math.max(normalizeFloat(input.area, 360), 160);
  const footprintArea = Math.max(area / floors, 120);
  const width = Math.max(Math.sqrt(footprintArea * 1.25), 10);
  const depth = Math.max(footprintArea / width, 8);
  const printable = INTENT_PROFILES[modelIntent]?.printable;

  return {
    id: slugify(input.buildingName || 'heritage_building'),
    name: normalizeText(input.buildingName, 'Heritage Building'),
    style: normalizeText(input.architecturalStyle, 'Traditional heritage'),
    buildingType: normalizeText(input.targetFunction, 'Adaptive reuse building'),
    area,
    floors,
    width,
    depth,
    height: floors * 3.9,
    wallThickness: printable ? 1.2 : 0.35,
    styleElements: parseCsvList(input.styleElements || 'arches, windows, doors, facade bands'),
    heritageValue: normalizeText(input.heritageValue),
    notes: normalizeText(input.notes),
    palette: colorFromStyle(input.architecturalStyle),
    detailLevel,
    sourceJobId: null,
    generationMode: 'conceptual-massing',
    sourceViews: {},
    modelingGuidance: {
      hasFront: false,
      hasRear: false,
      hasSideViews: false,
      hasAerial: false,
      hasInterior: false,
      hasFloorPlan: false,
      hasNight: false,
      hasStreet: false,
      multiFacadeCoverage: 0,
      facadeComplexity: 0.34,
      courtyardLikelihood: 0.1,
      roofArticulation: 0.18,
      asymmetry: 0.18,
      facadeDepth: 0.18,
      openingDepth: 0.12,
    },
    roofType: 'articulated_flat',
    facadeDepthFactor: 0.18,
    openingDepthFactor: 0.12,
    courtyardRatio: 0.1,
    massingVariation: 0.28,
    sideArticulation: 0.14,
    asymmetry: 0.18,
  };
}

function inferUploadedSceneScopeHint(input, uploadedFilesSummary) {
  const haystack = [
    input.projectTitle,
    input.buildingName,
    input.districtName,
    input.location,
    input.notes,
    ...(uploadedFilesSummary.items || []).map(item => item.originalName),
  ].map(value => normalizeText(value).toLowerCase()).join(' ');

  const districtHints = [
    'district', 'neighborhood', 'neighbourhood', 'street', 'streets', 'block', 'urban', 'masterplan',
    'master plan', 'site plan', 'houses', 'rows of houses', 'buildings', 'context', 'roads', 'alleys',
    'حي', 'حارة', 'منطقة', 'حي تاريخي', 'شوارع', 'مباني', 'مجموعة مبان', 'مخطط',
  ];
  const buildingHints = [
    'single building', 'one building', 'facade', 'front facade', 'elevation', 'entrance',
    'مبنى', 'واجهة', 'مدخل',
  ];

  const districtScore = districtHints.reduce((count, hint) => count + (haystack.includes(hint) ? 1 : 0), 0);
  const buildingScore = buildingHints.reduce((count, hint) => count + (haystack.includes(hint) ? 1 : 0), 0);
  if (districtScore > buildingScore) return 'district';
  return 'building';
}

function normalizeUploadedSceneAnalysis(analysis, input, uploadedFilesSummary) {
  const scopeHint = inferUploadedSceneScopeHint(input, uploadedFilesSummary);
  const streetCount = clamp(normalizeInteger(analysis?.streetCount, scopeHint === 'district' ? 1 : 0), 0, 6);
  const publicSpaceCount = clamp(normalizeInteger(analysis?.publicSpaceCount, scopeHint === 'district' ? 1 : 0), 0, 4);
  const openSpaceCount = clamp(normalizeInteger(analysis?.openSpaceCount, scopeHint === 'district' ? 1 : 0), 0, 4);
  const buildingCountHint = normalizeInteger(analysis?.buildingCount, 0);
  const rawScope = normalizeText(analysis?.scope).toLowerCase();
  const scope = ['building', 'district'].includes(rawScope)
    ? rawScope
    : (buildingCountHint > 1 || streetCount > 0 || publicSpaceCount > 0 || openSpaceCount > 0 || scopeHint === 'district'
      ? 'district'
      : 'building');
  const buildingCount = scope === 'district'
    ? clamp(buildingCountHint || Math.max((uploadedFilesSummary.images || 1) + 2, 3), 2, 8)
    : 1;
  const floorsMin = clamp(normalizeInteger(analysis?.floorsMin, Math.max(normalizeInteger(input.floors, 2), 1)), 1, 8);
  const floorsMax = clamp(Math.max(normalizeInteger(analysis?.floorsMax, floorsMin), floorsMin), floorsMin, 10);
  const keyElements = Array.isArray(analysis?.keyElements)
    ? analysis.keyElements.map(item => normalizeText(item)).filter(Boolean).slice(0, 12)
    : parseCsvList(analysis?.keyElements || input.styleElements || 'arches, windows, doors, facade bands');

  return {
    scope,
    sceneType: normalizeText(analysis?.sceneType, scope === 'district' ? 'street_block' : 'single_building'),
    buildingCount,
    streetCount,
    publicSpaceCount,
    openSpaceCount,
    urbanPattern: normalizeText(analysis?.urbanPattern, scope === 'district' ? 'Organic' : 'Compact'),
    architecturalStyle: normalizeText(analysis?.architecturalStyle, input.architecturalStyle || ''),
    buildingName: normalizeText(analysis?.buildingName, input.buildingName || ''),
    districtName: normalizeText(analysis?.districtName, input.districtName || ''),
    dominantBuildingType: normalizeText(analysis?.dominantBuildingType, input.targetFunction || 'Heritage building'),
    floorsMin,
    floorsMax,
    keyElements,
    reason: compactText(analysis?.reason || analysis?.notes || '', 260),
    notes: compactText(analysis?.notes || analysis?.reason || '', 420),
  };
}

async function analyzeUploadedSceneWithVision(input, uploadedFilesSummary) {
  const rasterPaths = (uploadedFilesSummary.items || [])
    .filter(item => item.category === 'image' && item.storedPath && fs.existsSync(item.storedPath))
    .map(item => item.storedPath)
    .slice(0, 3);

  if (!rasterPaths.length) return null;

  const fallback = normalizeUploadedSceneAnalysis({}, input, uploadedFilesSummary);
  if (!replicate) return fallback;

  try {
    const output = await replicate.run(SERVICE_05_SCENE_ANALYSIS_MODEL, {
      input: {
        system_prompt: 'You are an expert urban heritage analyst for architectural 3D reconstruction. Look at uploaded site photos and decide whether they depict a single building or a multi-building street/district scene. Always respond with valid JSON only.',
        prompt: `Analyze these uploaded architectural reference images for Service 05.

Determine whether the scene should be modeled as a single building or as a district / street block.
Focus on what is visibly present in the image, not on imagined future design intent.

Project hints:
- Project title: ${normalizeText(input.projectTitle, 'Unknown')}
- User building name: ${normalizeText(input.buildingName, 'Unknown')}
- User district name: ${normalizeText(input.districtName, 'Unknown')}
- Location: ${normalizeText(input.location, 'Unknown')}
- Architectural style hint: ${normalizeText(input.architecturalStyle, 'Unknown')}
- Notes: ${normalizeText(input.notes, 'None')}

Return ONLY this JSON object:
{
  "scope": "building or district",
  "sceneType": "single_building / street_block / district",
  "buildingCount": 0,
  "streetCount": 0,
  "publicSpaceCount": 0,
  "openSpaceCount": 0,
  "urbanPattern": "Organic / Grid / Mixed / Compact",
  "architecturalStyle": "...",
  "buildingName": "...",
  "districtName": "...",
  "dominantBuildingType": "...",
  "floorsMin": 1,
  "floorsMax": 3,
  "keyElements": ["..."],
  "reason": "brief explanation",
  "notes": "brief modeling guidance"
}`,
        image_input: rasterPaths.map(fileToDataUri),
        max_completion_tokens: 500,
        temperature: 0.1,
      },
    });

    const text = Array.isArray(output) ? output.join('') : String(output || '');
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return fallback;
    return normalizeUploadedSceneAnalysis(JSON.parse(json), input, uploadedFilesSummary);
  } catch (error) {
    return {
      ...fallback,
      notes: compactText(`Uploaded-scene analysis fallback used. ${error.message}`, 420),
    };
  }
}

function buildUploadedSceneBuildingSpecs(input, detailLevel, modelIntent, sceneAnalysis) {
  const printable = INTENT_PROFILES[modelIntent]?.printable;
  const baseStyle = normalizeText(input.architecturalStyle, sceneAnalysis.architecturalStyle || 'Traditional heritage');
  const baseType = normalizeText(input.targetFunction, sceneAnalysis.dominantBuildingType || 'Heritage building');
  const baseFloors = clamp(
    normalizeInteger(input.floors, Math.round((sceneAnalysis.floorsMin + sceneAnalysis.floorsMax) / 2) || 2),
    sceneAnalysis.floorsMin,
    sceneAnalysis.floorsMax
  );
  const baseArea = Math.max(normalizeFloat(input.area, sceneAnalysis.scope === 'district' ? 280 : 360), 160);
  const count = sceneAnalysis.scope === 'district' ? sceneAnalysis.buildingCount : 1;
  const keyElements = sceneAnalysis.keyElements.length
    ? sceneAnalysis.keyElements
    : parseCsvList(input.styleElements || 'arches, windows, doors, facade bands');
  const facadeComplexity = clamp(
    0.36 + keyElements.length * 0.026 + (sceneAnalysis.streetCount ? 0.08 : 0),
    0.34,
    0.88
  );

  return Array.from({ length: count }, (_, index) => {
    const roleMultiplier = index === 0 ? 1.18 : 0.72 + (index % 3) * 0.12;
    const floors = clamp(baseFloors + (index === 0 ? 0 : (index % 3) - 1), 1, Math.max(sceneAnalysis.floorsMax, baseFloors));
    const area = Math.max(baseArea * roleMultiplier, 140);
    const footprintArea = Math.max(area / Math.max(floors, 1), 110);
    const width = Math.max(Math.sqrt(footprintArea * (1.18 + (index % 2) * 0.12)), 8.4);
    const depth = Math.max(footprintArea / width, 7.2);
    const name = index === 0
      ? normalizeText(input.buildingName, sceneAnalysis.buildingName || 'Primary Heritage Building')
      : `${normalizeText(sceneAnalysis.districtName, 'Context')} Building ${index + 1}`;
    const style = normalizeText(baseStyle, 'Traditional heritage');
    const buildingType = index === 0
      ? normalizeText(baseType, 'Adaptive reuse building')
      : normalizeText(sceneAnalysis.dominantBuildingType, 'Context heritage building');
    const guidance = {
      hasFront: index === 0,
      hasRear: false,
      hasSideViews: sceneAnalysis.scope === 'district',
      hasAerial: false,
      hasInterior: false,
      hasFloorPlan: false,
      hasNight: false,
      hasStreet: sceneAnalysis.streetCount > 0,
      multiFacadeCoverage: sceneAnalysis.scope === 'district' ? 2 : 1,
      facadeComplexity: clamp(facadeComplexity - index * 0.04, 0.34, 0.88),
      courtyardLikelihood: clamp((sceneAnalysis.scope === 'district' ? 0.18 : 0.1) + (keyElements.some(item => item.toLowerCase().includes('courtyard')) ? 0.14 : 0), 0.1, 0.58),
      roofArticulation: clamp(0.2 + (sceneAnalysis.scope === 'district' ? 0.08 : 0), 0.18, 0.62),
      asymmetry: clamp(sceneAnalysis.scope === 'district' ? 0.24 + (index % 2) * 0.06 : 0.18, 0.16, 0.46),
      facadeDepth: clamp(0.2 + facadeComplexity * 0.22, 0.18, 0.5),
      openingDepth: clamp(0.12 + facadeComplexity * 0.18, 0.12, 0.34),
    };

    return {
      id: slugify(name, index === 0 ? 'primary_heritage_building' : `context_building_${index + 1}`),
      name,
      style,
      buildingType,
      area,
      floors,
      width,
      depth,
      height: floors * 3.7,
      wallThickness: printable ? 1.2 : 0.35,
      styleElements: keyElements,
      heritageValue: sceneAnalysis.scope === 'district' ? 'Contributing urban fabric' : 'Primary heritage asset',
      notes: sceneAnalysis.notes || normalizeText(input.notes),
      palette: colorFromStyle(style),
      detailLevel,
      sourceJobId: null,
      generationMode: sceneAnalysis.scope === 'district' ? 'uploaded-scene-district' : 'uploaded-scene-building',
      sourceViews: {},
      modelingGuidance: guidance,
      roofType: keyElements.some(item => item.toLowerCase().includes('courtyard'))
        ? 'courtyard_u'
        : sceneAnalysis.scope === 'district'
          ? (index % 2 ? 'stepped_roof' : 'articulated_flat')
          : 'articulated_flat',
      facadeDepthFactor: guidance.facadeDepth,
      openingDepthFactor: guidance.openingDepth,
      courtyardRatio: guidance.courtyardLikelihood,
      massingVariation: guidance.facadeComplexity,
      sideArticulation: guidance.hasSideViews ? 0.3 : 0.14,
      asymmetry: guidance.asymmetry,
    };
  });
}

async function buildUploadedSceneContext(input, uploadedFilesSummary, detailLevel, modelIntent) {
  const analysis = await analyzeUploadedSceneWithVision(input, uploadedFilesSummary);
  if (!analysis) return null;

  return {
    service: null,
    serviceName: 'Uploaded Scene Context',
    derivedFromUploads: true,
    districtName: normalizeText(input.districtName, analysis.districtName || ''),
    city: normalizeText(input.city, input.location || ''),
    urbanAnalysis: {
      detectedStyle: normalizeText(analysis.architecturalStyle, input.architecturalStyle || 'Traditional heritage'),
      urbanPattern: normalizeText(analysis.urbanPattern, analysis.scope === 'district' ? 'Organic' : 'Compact'),
      keyFeatures: analysis.keyElements,
      heritageValue: analysis.scope === 'district' ? 'High' : 'Medium',
      restorationNotes: analysis.notes || analysis.reason || '',
    },
    spatialGuidance: {
      terrainReliefBias: analysis.scope === 'district' ? 0.22 : 0.16,
      streetCount: analysis.streetCount,
      publicSpaceCount: analysis.publicSpaceCount,
      openSpaceCount: analysis.openSpaceCount,
      buildingCount: analysis.buildingCount,
      urbanPattern: normalizeText(analysis.urbanPattern, analysis.scope === 'district' ? 'Organic' : 'Compact'),
      style: normalizeText(analysis.architecturalStyle, input.architecturalStyle || ''),
      keyFeatures: analysis.keyElements,
    },
    terrainSummary: {
      reliefMeters: analysis.scope === 'district' ? 3 : 0,
    },
    representativeImages: (uploadedFilesSummary.items || [])
      .filter(item => item.category === 'image' && item.storedPath && fs.existsSync(item.storedPath))
      .map(item => item.storedPath)
      .slice(0, 6),
    buildingSpecs: buildUploadedSceneBuildingSpecs(input, detailLevel, modelIntent, analysis),
    analysis,
  };
}

function getSpatialContext(context) {
  return context.linkedServices.service3 || context.linkedServices.uploadedSceneContext || null;
}

async function buildModelContext(input, linkedJobs, uploadedFilesSummary) {
  const service2Jobs = linkedJobs.filter(job => job.service === 2);
  const service3 = linkedJobs.find(job => job.service === 3) || null;
  const detailLevel = ['low', 'medium', 'high'].includes(normalizeText(input.detailLevel, 'medium'))
    ? normalizeText(input.detailLevel, 'medium')
    : 'medium';
  const modelIntent = Object.keys(INTENT_PROFILES).includes(normalizeText(input.modelIntent, 'presentation'))
    ? normalizeText(input.modelIntent, 'presentation')
    : 'presentation';
  const uploadedSceneContext = !service3 && !service2Jobs.length
    ? await buildUploadedSceneContext(input, uploadedFilesSummary, detailLevel, modelIntent)
    : null;
  const spatialContext = service3 || uploadedSceneContext;
  const requestedScope = normalizeText(input.modelScope, 'auto');
  const modelScope = requestedScope === 'auto'
    ? (spatialContext?.analysis?.scope === 'district' || service2Jobs.length > 1 || service3 ? 'district' : 'building')
    : requestedScope;
  const exportFormats = parseCsvList(input.exportFormats || 'obj,stl,glb,fbx');
  const uploadedSceneBuildings = uploadedSceneContext?.buildingSpecs || [];
  const targetBuildings = service2Jobs.length
    ? service2Jobs.map((job, index) => buildBuildingSpec(job, detailLevel, modelIntent, index))
    : uploadedSceneBuildings.length
      ? (modelScope === 'district' ? uploadedSceneBuildings : [uploadedSceneBuildings[0]])
      : [buildFallbackBuildingSpec(input, detailLevel, modelIntent)];
  const generationMode = service3
    ? 'guided-district'
    : service2Jobs.length
      ? 'guided-building'
      : uploadedSceneContext
        ? modelScope === 'district'
          ? 'uploaded-scene-district'
          : 'uploaded-scene-building'
        : 'conceptual-massing';

  return {
    project: {
      title: normalizeText(input.projectTitle)
        || normalizeText(input.buildingName)
        || normalizeText(spatialContext?.districtName)
        || normalizeText(targetBuildings[0]?.name, 'Heritage 3D Modeling Project'),
      buildingName: normalizeText(input.buildingName, uploadedSceneContext?.analysis?.buildingName || targetBuildings[0]?.name || 'Heritage Building'),
      districtName: normalizeText(input.districtName, spatialContext?.districtName || ''),
      city: normalizeText(input.city, spatialContext?.city || ''),
      location: normalizeText(input.location, spatialContext?.city || ''),
      architecturalStyle: normalizeText(input.architecturalStyle, targetBuildings[0]?.style || spatialContext?.urbanAnalysis?.detectedStyle || ''),
      notes: normalizeText(input.notes, uploadedSceneContext?.analysis?.notes || ''),
    },
    modeling: {
      detailLevel,
      detailProfile: DETAIL_PROFILES[detailLevel],
      modelIntent,
      intentProfile: INTENT_PROFILES[modelIntent],
      modelScope,
      minimumThicknessMm: Math.max(normalizeFloat(input.minimumThicknessMm, modelIntent === 'printing' ? 2.4 : 1.2), modelIntent === 'printing' ? 2 : 0.8),
      strategicViewCount: Math.max(normalizeInteger(input.renderViewCount, 6), 4),
      includeTerrain: String(input.includeTerrain || (spatialContext ? 'true' : 'false')).toLowerCase() !== 'false',
      includeMasterPlan: String(input.includeMasterPlan || (modelScope === 'district' ? 'true' : 'false')).toLowerCase() !== 'false',
      includeSeparateBuildings: String(input.includeSeparateBuildings || 'true').toLowerCase() !== 'false',
      exportFormats: exportFormats.length ? exportFormats : ['obj', 'stl', 'glb', 'fbx'],
      htmlViewer: String(input.htmlViewer || 'true').toLowerCase() !== 'false',
      renderEngine: normalizeText(input.renderEngine, 'blender'),
      renderStyle: normalizeText(input.renderStyle, 'architectural_presentation'),
      renderQuality: ['standard', 'high', 'ultra'].includes(normalizeText(input.renderQuality, 'high'))
        ? normalizeText(input.renderQuality, 'high')
        : 'high',
      enablePostEnhancement: String(input.enablePostEnhancement || 'true').toLowerCase() !== 'false',
      hdriPath: normalizeText(input.hdriPath),
      generationMode,
    },
    linkedServices: {
      service2Jobs,
      service3,
      uploadedSceneContext,
    },
    targetBuildings,
    uploadedFilesSummary,
    uploadedSceneAnalysis: uploadedSceneContext?.analysis || null,
    representativeImages: pickRepresentativeImages(linkedJobs, uploadedFilesSummary),
    generatedAt: new Date().toISOString(),
  };
}

function buildBoxMesh(name, x, y, z, width, depth, height, colorHex) {
  const vertices = [
    [x, y, z],
    [x + width, y, z],
    [x + width, y + depth, z],
    [x, y + depth, z],
    [x, y, z + height],
    [x + width, y, z + height],
    [x + width, y + depth, z + height],
    [x, y + depth, z + height],
  ];

  const faces = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3],
    [3, 7, 4], [3, 4, 0],
  ];

  return { name, vertices, faces, colorHex };
}

function buildTerrainMesh(name, width, depth, segmentsX, segmentsY, relief, colorHex) {
  const vertices = [];
  const faces = [];

  for (let y = 0; y <= segmentsY; y += 1) {
    for (let x = 0; x <= segmentsX; x += 1) {
      const px = (x / segmentsX) * width;
      const py = (y / segmentsY) * depth;
      const z = Math.sin((x / segmentsX) * Math.PI * 2) * relief * 0.45
        + Math.cos((y / segmentsY) * Math.PI * 1.2) * relief * 0.55;
      vertices.push([px, py, z]);
    }
  }

  const stride = segmentsX + 1;
  for (let y = 0; y < segmentsY; y += 1) {
    for (let x = 0; x < segmentsX; x += 1) {
      const a = y * stride + x;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      faces.push([a, c, b], [b, c, d]);
    }
  }

  return { name, vertices, faces, colorHex };
}

function cloneMesh(mesh) {
  return {
    name: mesh.name,
    vertices: mesh.vertices.map(vertex => [...vertex]),
    faces: mesh.faces.map(face => [...face]),
    colorHex: mesh.colorHex,
  };
}

function translateMesh(mesh, dx, dy, dz) {
  const copy = cloneMesh(mesh);
  copy.vertices = copy.vertices.map(([x, y, z]) => [x + dx, y + dy, z + dz]);
  return copy;
}

function scaleMesh(mesh, factor) {
  const copy = cloneMesh(mesh);
  copy.vertices = copy.vertices.map(([x, y, z]) => [x * factor, y * factor, z * factor]);
  return copy;
}

function mergeMeshes(name, meshes, colorHex = '#b99d7a') {
  const vertices = [];
  const faces = [];
  let offset = 0;

  for (const mesh of meshes) {
    if (!mesh) continue;
    vertices.push(...mesh.vertices.map(vertex => [...vertex]));
    faces.push(...mesh.faces.map(face => face.map(index => index + offset)));
    offset += mesh.vertices.length;
  }

  return { name, vertices, faces, colorHex };
}

function buildBuildingMeshes(spec, modeling) {
  const profile = DETAIL_PROFILES[spec.detailLevel] || DETAIL_PROFILES.medium;
  const meshes = [];
  const baseColor = spec.palette.base;
  const accentColor = spec.palette.accent;
  const roofColor = spec.palette.roof;
  const detailColor = spec.palette.detail;
  const guidance = spec.modelingGuidance || {};
  const massingVariation = spec.massingVariation || 0.36;
  const baseHeight = spec.height;
  const plinthHeight = Math.max(0.45, spec.height * 0.04);
  const parapetHeight = spec.detailLevel === 'high' ? 0.55 : 0.35;
  const facadeDepth = Math.max(profile.ornamentDepth * 1.2, spec.facadeDepthFactor || profile.ornamentDepth, modeling.minimumThicknessMm / 1000);
  const openingDepth = Math.max(spec.openingDepthFactor || 0.12, facadeDepth * 0.72);
  const bodyInset = 0.24;
  const wingDepth = clamp(spec.depth * (0.22 + massingVariation * 0.16), 2.2, spec.depth * 0.38);
  const sideWingWidth = clamp(spec.width * (0.2 + guidance.multiFacadeCoverage * 0.03), 2.2, spec.width * 0.3);
  const frontProjection = clamp(spec.width * (0.16 + massingVariation * 0.12), 2, spec.width * 0.32);
  const asymmetryOffset = spec.width * (spec.asymmetry || 0.18) * 0.18;
  const courtyardWidth = clamp(spec.width * (spec.courtyardRatio || 0.12), 2.4, spec.width * 0.34);
  const courtyardDepth = clamp(spec.depth * (spec.courtyardRatio || 0.12), 2.6, spec.depth * 0.36);
  const floorHeight = baseHeight / Math.max(spec.floors, 1);
  const rows = profile.windowRows * spec.floors;
  const cols = profile.windowCols + (guidance.hasSideViews ? 1 : 0);
  const windowWidth = Math.max(0.9, spec.width * 0.08);
  const windowHeight = Math.max(1.1, floorHeight * 0.46);

  const addMassingShell = (name, x, y, z, width, depth, height, color) => {
    if (width <= 0.4 || depth <= 0.4 || height <= 0.4) return;
    meshes.push(buildBoxMesh(`${spec.id}_${name}`, x, y, z, width, depth, height, color));
  };

  meshes.push(buildBoxMesh(`${spec.id}_plinth`, 0, 0, 0, spec.width, spec.depth, plinthHeight, accentColor));

  if (spec.roofType === 'courtyard_ring') {
    addMassingShell('front_wing', bodyInset, bodyInset, plinthHeight, spec.width - bodyInset * 2, wingDepth, baseHeight, baseColor);
    addMassingShell('rear_wing', bodyInset, spec.depth - wingDepth - bodyInset, plinthHeight, spec.width - bodyInset * 2, wingDepth, baseHeight * 0.96, baseColor);
    addMassingShell('left_wing', bodyInset, bodyInset + wingDepth * 0.62, plinthHeight, sideWingWidth, spec.depth - wingDepth * 1.28 - bodyInset * 2, baseHeight * 0.98, baseColor);
    addMassingShell('right_wing', spec.width - sideWingWidth - bodyInset, bodyInset + wingDepth * 0.62, plinthHeight, sideWingWidth, spec.depth - wingDepth * 1.28 - bodyInset * 2, baseHeight * 0.98, baseColor);
    meshes.push(buildBoxMesh(`${spec.id}_courtyard_floor`, (spec.width - courtyardWidth) / 2, (spec.depth - courtyardDepth) / 2, plinthHeight + 0.04, courtyardWidth, courtyardDepth, 0.12, detailColor));
  } else if (spec.roofType === 'courtyard_u') {
    addMassingShell('rear_bar', bodyInset, spec.depth - wingDepth - bodyInset, plinthHeight, spec.width - bodyInset * 2, wingDepth, baseHeight, baseColor);
    addMassingShell('left_leg', bodyInset, bodyInset + asymmetryOffset * 0.35, plinthHeight, sideWingWidth, spec.depth - wingDepth - bodyInset * 2, baseHeight * 0.95, baseColor);
    addMassingShell('right_leg', spec.width - sideWingWidth - bodyInset, bodyInset, plinthHeight, sideWingWidth, spec.depth - wingDepth - bodyInset * 2, baseHeight * 0.9, baseColor);
    addMassingShell('entry_bar', (spec.width - frontProjection) / 2 + asymmetryOffset, bodyInset, plinthHeight, frontProjection, wingDepth * 0.72, baseHeight * 0.68, accentColor);
    meshes.push(buildBoxMesh(`${spec.id}_courtyard_floor`, spec.width * 0.28, spec.depth * 0.22, plinthHeight + 0.04, spec.width * 0.44, spec.depth * 0.36, 0.12, detailColor));
  } else {
    addMassingShell('main_bar', bodyInset, bodyInset, plinthHeight, spec.width - bodyInset * 2, spec.depth - bodyInset * 2, baseHeight, baseColor);
    addMassingShell('front_projection', (spec.width - frontProjection) / 2 + asymmetryOffset, bodyInset - wingDepth * 0.18, plinthHeight, frontProjection, wingDepth * 0.82, baseHeight * 0.74, accentColor);
    if (guidance.hasSideViews) {
      addMassingShell('side_wing', spec.width - sideWingWidth - bodyInset, spec.depth * 0.18, plinthHeight, sideWingWidth, spec.depth * 0.54, baseHeight * 0.86, baseColor);
    }
    if (guidance.hasRear) {
      addMassingShell('rear_service', spec.width * 0.18, spec.depth - wingDepth * 0.74, plinthHeight, spec.width * 0.34, wingDepth * 0.54, baseHeight * 0.42, accentColor);
    }
  }

  const roofSegments = [
    { name: 'roof_main', x: bodyInset * 0.5, y: bodyInset * 0.5, w: spec.width - bodyInset, d: spec.depth - bodyInset, h: 0.38 + guidance.roofArticulation * 0.32 },
    { name: 'roof_lantern', x: spec.width * 0.34 + asymmetryOffset * 0.25, y: spec.depth * 0.34, w: spec.width * 0.2, d: spec.depth * 0.16, h: 0.32 + guidance.roofArticulation * 0.24 },
  ];
  roofSegments.forEach(segment => {
    addMassingShell(segment.name, segment.x, segment.y, plinthHeight + baseHeight, segment.w, segment.d, segment.h, roofColor);
  });

  meshes.push(buildBoxMesh(`${spec.id}_parapet_front`, 0.12, 0.08, plinthHeight + baseHeight + 0.18, spec.width - 0.24, 0.22, parapetHeight, detailColor));
  meshes.push(buildBoxMesh(`${spec.id}_parapet_back`, 0.12, spec.depth - 0.3, plinthHeight + baseHeight + 0.18, spec.width - 0.24, 0.22, parapetHeight * 0.95, detailColor));
  meshes.push(buildBoxMesh(`${spec.id}_parapet_left`, 0.08, 0.12, plinthHeight + baseHeight + 0.18, 0.22, spec.depth - 0.24, parapetHeight, detailColor));
  meshes.push(buildBoxMesh(`${spec.id}_parapet_right`, spec.width - 0.3, 0.12, plinthHeight + baseHeight + 0.18, 0.22, spec.depth - 0.24, parapetHeight, detailColor));

  const towerWidth = clamp(spec.width * 0.16, 1.8, 3.2);
  addMassingShell('stair_tower', spec.width - towerWidth - bodyInset * 0.6, spec.depth * 0.18, plinthHeight, towerWidth, spec.depth * 0.2, baseHeight + 0.7, accentColor);

  const doorWidth = Math.max(1.5, spec.width * 0.12);
  const doorX = (spec.width - doorWidth) / 2 + asymmetryOffset * 0.45;
  meshes.push(buildBoxMesh(`${spec.id}_door_frame`, doorX, -openingDepth, plinthHeight, doorWidth, openingDepth, 2.8, accentColor));
  meshes.push(buildBoxMesh(`${spec.id}_door_surround`, doorX - 0.18, -facadeDepth, plinthHeight - 0.06, doorWidth + 0.36, facadeDepth, 3.3, detailColor));
  meshes.push(buildBoxMesh(`${spec.id}_door_arch`, doorX - 0.12, -facadeDepth, plinthHeight + 2.74, doorWidth + 0.24, facadeDepth, 0.38, detailColor));

  const bandCount = profile.facadeBands + (guidance.hasFront ? 1 : 0);
  for (let band = 0; band < bandCount; band += 1) {
    const z = plinthHeight + baseHeight * (0.18 + band * 0.18);
    meshes.push(buildBoxMesh(`${spec.id}_band_front_${band + 1}`, 0.2, -facadeDepth * 0.8, z, spec.width - 0.4, facadeDepth * 0.8, 0.16, detailColor));
    meshes.push(buildBoxMesh(`${spec.id}_band_back_${band + 1}`, 0.2, spec.depth, z, spec.width - 0.4, facadeDepth * 0.8, 0.14, detailColor));
  }

  const usableWidth = spec.width * 0.72;
  const stepX = usableWidth / Math.max(cols - 1, 1);
  const startX = (spec.width - usableWidth) / 2 - windowWidth / 2;
  const stepZ = baseHeight / (rows + 1);
  const archHeight = guidance.facadeComplexity > 0.55 ? 0.28 : 0.18;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = startX + col * stepX;
      const z = plinthHeight + stepZ * (row + 1);
      const useAccent = (row + col) % 2 === 0;
      meshes.push(buildBoxMesh(`${spec.id}_win_f_${row}_${col}`, x, -openingDepth, z, windowWidth, openingDepth, windowHeight, useAccent ? accentColor : detailColor));
      meshes.push(buildBoxMesh(`${spec.id}_frame_f_${row}_${col}`, x - 0.08, -facadeDepth, z - 0.06, windowWidth + 0.16, facadeDepth * 0.72, windowHeight + 0.12, detailColor));
      if (guidance.facadeComplexity > 0.48) {
        meshes.push(buildBoxMesh(`${spec.id}_arch_f_${row}_${col}`, x - 0.05, -facadeDepth, z + windowHeight, windowWidth + 0.1, facadeDepth * 0.7, archHeight, detailColor));
      }
      if (guidance.hasRear || row < rows - 1) {
        meshes.push(buildBoxMesh(`${spec.id}_win_b_${row}_${col}`, x, spec.depth, z, windowWidth, openingDepth, windowHeight, accentColor));
      }
      if (guidance.hasSideViews) {
        const sideY = 0.9 + col * ((spec.depth - 1.8) / Math.max(cols, 1));
        meshes.push(buildBoxMesh(`${spec.id}_win_l_${row}_${col}`, -openingDepth, sideY, z, openingDepth, windowWidth, windowHeight, accentColor));
        meshes.push(buildBoxMesh(`${spec.id}_win_r_${row}_${col}`, spec.width, sideY, z, openingDepth, windowWidth, windowHeight, accentColor));
      }
    }
  }

  if (guidance.hasStreet || guidance.hasFront) {
    const arcadeWidth = clamp(spec.width * 0.18, 1.4, 2.8);
    for (let i = 0; i < 3; i += 1) {
      const x = spec.width * 0.14 + i * arcadeWidth * 1.12;
      meshes.push(buildBoxMesh(`${spec.id}_arcade_post_${i + 1}`, x, -facadeDepth * 1.08, plinthHeight, 0.16, facadeDepth * 1.08, 2.7, detailColor));
      meshes.push(buildBoxMesh(`${spec.id}_arcade_lintel_${i + 1}`, x - 0.08, -facadeDepth * 1.08, plinthHeight + 2.65, arcadeWidth, facadeDepth * 0.9, 0.16, detailColor));
    }
  }

  return meshes;
}

function computeBounds(mesh) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const [x, y, z] of mesh.vertices) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    width: maxX - minX,
    depth: maxY - minY,
    height: maxZ - minZ,
  };
}

function computeBoundsForMeshes(meshes) {
  const filtered = (Array.isArray(meshes) ? meshes : [meshes]).filter(Boolean);
  if (!filtered.length) {
    return {
      minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1,
      width: 1, depth: 1, height: 1,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const mesh of filtered) {
    const bounds = computeBounds(mesh);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    minZ = Math.min(minZ, bounds.minZ);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
    maxZ = Math.max(maxZ, bounds.maxZ);
  }

  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    width: maxX - minX,
    depth: maxY - minY,
    height: maxZ - minZ,
  };
}

function buildSceneGeometry(context) {
  const { targetBuildings, linkedServices, modeling } = context;
  const buildingEntries = [];
  const sceneMeshes = [];
  const spatialContext = linkedServices.service3 || linkedServices.uploadedSceneContext || null;
  const service3Guidance = spatialContext?.spatialGuidance || {};
  const totalWidth = targetBuildings.reduce((sum, building) => sum + building.width, 0);
  const maxDepth = targetBuildings.reduce((sum, building) => Math.max(sum, building.depth), 0);
  const districtTargetCount = Math.max(service3Guidance.buildingCount || 0, targetBuildings.length + 2);
  const districtWidth = Math.max(totalWidth + districtTargetCount * 6 + 34, 84);
  const districtDepth = Math.max(maxDepth * 2.4 + 42 + (service3Guidance.publicSpaceCount || 0) * 4, 72);
  const terrainRelief = spatialContext?.terrainSummary?.reliefMeters
    ? Math.min(Math.max(normalizeFloat(spatialContext.terrainSummary.reliefMeters, 3) / 12, 1.2), 8)
    : (context.modeling.includeTerrain ? 2.2 : 0);
  const urbanPattern = normalizeText(service3Guidance.urbanPattern, 'Organic').toLowerCase();
  const stylePalette = colorFromStyle(service3Guidance.style || spatialContext?.urbanAnalysis?.detectedStyle || context.project.architecturalStyle);
  const contextBuildingColor = stylePalette.detail;

  if (modeling.modelScope === 'district') {
    if (modeling.includeTerrain) {
      const terrainColor = urbanPattern.includes('grid') ? '#b8aa92' : '#bca891';
      sceneMeshes.push(buildTerrainMesh('terrain', districtWidth, districtDepth, 24, 20, terrainRelief, terrainColor));
    }

    const streetCount = clamp(service3Guidance.streetCount || (urbanPattern.includes('grid') ? 3 : 2), 1, 4);
    const publicSpaceCount = clamp(service3Guidance.publicSpaceCount || 1, 1, 3);
    const openSpaceCount = clamp(service3Guidance.openSpaceCount || 1, 1, 3);
    const mainStreetWidth = urbanPattern.includes('organic') ? 7.2 : 8.4;
    const crossStreetWidth = mainStreetWidth * 0.72;

    sceneMeshes.push(buildBoxMesh('main_boulevard', districtWidth * 0.08, districtDepth * 0.46, 0.04, districtWidth * 0.84, mainStreetWidth, 0.16, '#6c6256'));
    sceneMeshes.push(buildBoxMesh('main_sidewalk_north', districtWidth * 0.08, districtDepth * 0.46 - 1.4, 0.05, districtWidth * 0.84, 1.2, 0.12, '#cdbda8'));
    sceneMeshes.push(buildBoxMesh('main_sidewalk_south', districtWidth * 0.08, districtDepth * 0.46 + mainStreetWidth + 0.2, 0.05, districtWidth * 0.84, 1.2, 0.12, '#cdbda8'));

    for (let i = 0; i < streetCount - 1; i += 1) {
      const x = districtWidth * (0.22 + i * 0.22);
      const y = urbanPattern.includes('organic') ? districtDepth * (0.18 + i * 0.07) : districtDepth * 0.18;
      const depth = urbanPattern.includes('organic') ? districtDepth * 0.54 : districtDepth * 0.64;
      sceneMeshes.push(buildBoxMesh(`cross_street_${i + 1}`, x, y, 0.04, crossStreetWidth, depth, 0.15, '#74695c'));
    }

    for (let i = 0; i < publicSpaceCount; i += 1) {
      const plazaWidth = districtWidth * (urbanPattern.includes('grid') ? 0.13 : 0.16);
      const plazaDepth = districtDepth * 0.12;
      const x = districtWidth * (0.18 + i * 0.26);
      const y = districtDepth * (urbanPattern.includes('organic') ? 0.23 + (i % 2) * 0.18 : 0.22 + (i % 2) * 0.22);
      sceneMeshes.push(buildBoxMesh(`public_space_${i + 1}`, x, y, 0.05, plazaWidth, plazaDepth, 0.12, '#8a7b66'));
      sceneMeshes.push(buildBoxMesh(`plaza_inset_${i + 1}`, x + 0.9, y + 0.9, 0.06, plazaWidth - 1.8, plazaDepth - 1.8, 0.05, '#a88a61'));
    }

    for (let i = 0; i < openSpaceCount; i += 1) {
      const x = districtWidth * (0.12 + i * 0.25);
      const y = districtDepth * 0.74;
      sceneMeshes.push(buildBoxMesh(`open_space_${i + 1}`, x, y, 0.05, districtWidth * 0.16, districtDepth * 0.1, 0.06, '#8f9a76'));
    }
  } else {
    const building = targetBuildings[0];
    const padWidth = building.width + 14;
    const padDepth = building.depth + 14;
    sceneMeshes.push(buildBoxMesh('presentation_plaza', 0, 0, 0, padWidth, padDepth, 0.18, '#b9ab95'));
    sceneMeshes.push(buildBoxMesh('presentation_courtyard', 1.4, 1.4, 0.04, padWidth - 2.8, padDepth - 2.8, 0.08, '#cdbda8'));
    sceneMeshes.push(buildBoxMesh('entry_walk', padWidth * 0.38, -0.2, 0.05, padWidth * 0.24, 2.8, 0.04, '#a88962'));
    sceneMeshes.push(buildBoxMesh('planter_left', 1.8, padDepth * 0.18, 0.06, 1.4, padDepth * 0.18, 0.26, '#8b916a'));
    sceneMeshes.push(buildBoxMesh('planter_right', padWidth - 3.2, padDepth * 0.18, 0.06, 1.4, padDepth * 0.18, 0.26, '#8b916a'));
  }

  const placementPositions = [];

  if (modeling.modelScope === 'district') {
    if (urbanPattern.includes('grid')) {
      const cols = Math.max(2, Math.ceil(Math.sqrt(targetBuildings.length)));
      const plotWidth = districtWidth / (cols + 1);
      targetBuildings.forEach((building, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const x = districtWidth * 0.12 + col * plotWidth + (plotWidth - building.width) * 0.18;
        const y = districtDepth * (0.19 + row * 0.3) + (row % 2 ? 8 : 0);
        placementPositions.push({ x, y, z: 0.12 });
        sceneMeshes.push(buildBoxMesh(`${building.id}_plot`, x - 1.4, y - 1.3, 0.04, building.width + 2.8, building.depth + 2.6, 0.12, '#cbbca8'));
        sceneMeshes.push(buildBoxMesh(`${building.id}_forecourt`, x + building.width * 0.18, y - 2.1, 0.05, building.width * 0.46, 1.2, 0.04, '#aa865d'));
      });
    } else if (urbanPattern.includes('mixed')) {
      const centerY = districtDepth * 0.48;
      targetBuildings.forEach((building, index) => {
        const cluster = index % 2;
        const slot = Math.floor(index / 2);
        const x = districtWidth * (cluster ? 0.56 : 0.14) + slot * (building.width + 4.2);
        const y = centerY + (cluster ? 8.4 : -building.depth - 3.2) + (slot % 2 ? 3.4 : -1.6);
        placementPositions.push({ x, y, z: 0.12 });
        sceneMeshes.push(buildBoxMesh(`${building.id}_plot`, x - 1.3, y - 1.2, 0.04, building.width + 2.6, building.depth + 2.4, 0.12, '#cfbfab'));
      });
    } else {
      const centerX = districtWidth * 0.5;
      const centerY = districtDepth * 0.5;
      const radiusX = Math.max(districtWidth * 0.24, 18);
      const radiusY = Math.max(districtDepth * 0.16, 12);
      targetBuildings.forEach((building, index) => {
        const angle = -0.9 + (index / Math.max(targetBuildings.length - 1, 1)) * 1.8;
        const x = centerX + Math.cos(angle) * radiusX - building.width * 0.5;
        const y = centerY + Math.sin(angle) * radiusY - building.depth * 0.5 + (index % 2 ? 2.4 : -1.4);
        placementPositions.push({ x, y, z: 0.12 });
        sceneMeshes.push(buildBoxMesh(`${building.id}_plot`, x - 1.2, y - 1.2, 0.04, building.width + 2.4, building.depth + 2.4, 0.12, '#ccbda8'));
        sceneMeshes.push(buildBoxMesh(`${building.id}_landscape_strip`, x - 0.6, y + building.depth + 0.2, 0.05, building.width + 1.2, 1.1, 0.06, '#87906f'));
      });
    }
  } else {
    placementPositions.push({ x: 7, y: 7, z: 0.12 });
  }

  targetBuildings.forEach((building, index) => {
    const buildingMeshes = buildBuildingMeshes(building, modeling);
    const placedAt = placementPositions[index] || { x: 6, y: 6, z: 0.12 };
    const placed = buildingMeshes.map(mesh => translateMesh(mesh, placedAt.x, placedAt.y, placedAt.z));
    const merged = mergeMeshes(`${building.id}_merged`, placed, building.palette.base);

    buildingEntries.push({
      ...building,
      position: placedAt,
      meshes: placed,
      mergedMesh: merged,
    });
    sceneMeshes.push(...placed);
  });

  if (modeling.modelScope === 'district') {
    const contextBuildings = clamp(Math.max(targetBuildings.length + 2, Math.round((service3Guidance.buildingCount || 0) * 0.35)), 4, 10);
    for (let i = 0; i < contextBuildings; i += 1) {
      const w = 5.8 + (i % 3) * 1.4;
      const d = 5.2 + (i % 2) * 2.1;
      const h = 5 + (i % 4) * 1.8;
      const x = 6 + (i * 11.2) % Math.max(districtWidth - 18, 18);
      const y = i % 2 === 0 ? 8.5 : districtDepth - d - 9.5;
      sceneMeshes.push(buildBoxMesh(`urban_context_${i + 1}`, x, y, 0.06, w, d, h, contextBuildingColor));
      sceneMeshes.push(buildBoxMesh(`urban_context_plot_${i + 1}`, x - 0.7, y - 0.7, 0.04, w + 1.4, d + 1.4, 0.08, '#c9baa5'));
    }
  }

  const masterScene = mergeMeshes('master_scene', sceneMeshes, '#b99d7a');
  const bounds = computeBounds(masterScene);
  const printScaleFactor = modeling.intentProfile.targetSceneWidthMm / Math.max(bounds.width, 1);

  return {
    buildings: buildingEntries,
    sceneMeshes,
    masterScene,
    printableMasterScene: scaleMesh(masterScene, printScaleFactor),
    printableBuildings: buildingEntries.map(entry => ({
      ...entry,
      printableMesh: scaleMesh(entry.mergedMesh, printScaleFactor),
    })),
    bounds,
    printableBounds: computeBounds(scaleMesh(masterScene, printScaleFactor)),
  };
}

function writeObj(mesh, outPath) {
  const lines = [`# ${mesh.name}`];
  for (const [x, y, z] of mesh.vertices) {
    lines.push(`v ${x.toFixed(6)} ${z.toFixed(6)} ${y.toFixed(6)}`);
  }
  lines.push(`o ${mesh.name}`);
  for (const [a, b, c] of mesh.faces) {
    lines.push(`f ${a + 1} ${b + 1} ${c + 1}`);
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
}

function computeFaceNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const len = Math.hypot(cross[0], cross[1], cross[2]) || 1;
  return [cross[0] / len, cross[1] / len, cross[2] / len];
}

function writeStl(mesh, outPath) {
  const lines = [`solid ${mesh.name}`];
  for (const [ia, ib, ic] of mesh.faces) {
    const a = mesh.vertices[ia];
    const b = mesh.vertices[ib];
    const c = mesh.vertices[ic];
    const normal = computeFaceNormal(a, b, c);
    lines.push(`  facet normal ${normal[0].toFixed(6)} ${normal[2].toFixed(6)} ${normal[1].toFixed(6)}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${a[0].toFixed(6)} ${a[2].toFixed(6)} ${a[1].toFixed(6)}`);
    lines.push(`      vertex ${b[0].toFixed(6)} ${b[2].toFixed(6)} ${b[1].toFixed(6)}`);
    lines.push(`      vertex ${c[0].toFixed(6)} ${c[2].toFixed(6)} ${c[1].toFixed(6)}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${mesh.name}`);
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`);
}

function buildGlb(mesh, outPath, colorHex) {
  const positionArray = new Float32Array(mesh.vertices.flatMap(([x, y, z]) => [x, z, y]));
  const indexArray = mesh.vertices.length > 65535
    ? new Uint32Array(mesh.faces.flat())
    : new Uint16Array(mesh.faces.flat());

  const positionBuffer = Buffer.from(positionArray.buffer);
  const indexBuffer = Buffer.from(indexArray.buffer);
  const jsonPadding = (length) => Buffer.alloc((4 - (length % 4)) % 4, 0x20);
  const binPadding = (length) => Buffer.alloc((4 - (length % 4)) % 4, 0);

  const color = hexToRgb01(colorHex);
  const bounds = computeBounds(mesh);
  const json = {
    asset: { version: '2.0', generator: 'Codex Service 05' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: mesh.name }],
    meshes: [{
      name: mesh.name,
      primitives: [{
        attributes: { POSITION: 0 },
        indices: 1,
        material: 0,
        mode: 4,
      }],
    }],
    materials: [{
      name: `${mesh.name}_material`,
      pbrMetallicRoughness: {
        baseColorFactor: [color.r, color.g, color.b, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.9,
      },
      doubleSided: true,
    }],
    buffers: [{ byteLength: positionBuffer.length + indexBuffer.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBuffer.length, target: 34962 },
      { buffer: 0, byteOffset: positionBuffer.length, byteLength: indexBuffer.length, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: mesh.vertices.length,
        type: 'VEC3',
        min: [bounds.minX, bounds.minZ, bounds.minY],
        max: [bounds.maxX, bounds.maxZ, bounds.maxY],
      },
      {
        bufferView: 1,
        componentType: indexArray instanceof Uint32Array ? 5125 : 5123,
        count: mesh.faces.length * 3,
        type: 'SCALAR',
      },
    ],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonBuffer, jsonPadding(jsonBuffer.length)]);
  const binChunk = Buffer.concat([positionBuffer, indexBuffer, binPadding(positionBuffer.length + indexBuffer.length)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.write('JSON', 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.write('BIN\0', 4);

  fs.writeFileSync(outPath, Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]));
}

function buildAsciiFbx(mesh, outPath, colorHex) {
  const verts = mesh.vertices.flatMap(([x, y, z]) => [x, z, y]);
  const polygonIndices = mesh.faces.flatMap(([a, b, c]) => [a, b, -(c + 1)]);
  const normals = mesh.faces.flatMap(([ia, ib, ic]) => {
    const normal = computeFaceNormal(mesh.vertices[ia], mesh.vertices[ib], mesh.vertices[ic]);
    return [normal, normal, normal].flatMap(([x, y, z]) => [x, z, y]);
  });
  const color = hexToRgb01(colorHex);

  const content = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
  Creator: "Codex Service 05"
}
GlobalSettings:  {
  Version: 1000
  Properties70:  {
    P: "UpAxis", "int", "Integer", "",1
    P: "UpAxisSign", "int", "Integer", "",1
    P: "FrontAxis", "int", "Integer", "",2
    P: "FrontAxisSign", "int", "Integer", "",1
    P: "CoordAxis", "int", "Integer", "",0
    P: "CoordAxisSign", "int", "Integer", "",1
    P: "UnitScaleFactor", "double", "Number", "",1
  }
}
Definitions:  {
  Version: 100
  Count: 3
  ObjectType: "Geometry" {
    Count: 1
  }
  ObjectType: "Model" {
    Count: 1
  }
  ObjectType: "Material" {
    Count: 1
  }
}
Objects:  {
  Geometry: 1001, "Geometry::${mesh.name}", "Mesh" {
    Vertices: *${verts.length} {
      a: ${verts.map(value => Number(value.toFixed(6))).join(',')}
    }
    PolygonVertexIndex: *${polygonIndices.length} {
      a: ${polygonIndices.join(',')}
    }
    GeometryVersion: 124
    LayerElementNormal: 0 {
      Version: 101
      Name: ""
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "Direct"
      Normals: *${normals.length} {
        a: ${normals.map(value => Number(value.toFixed(6))).join(',')}
      }
    }
    LayerElementMaterial: 0 {
      Version: 101
      Name: ""
      MappingInformationType: "AllSame"
      ReferenceInformationType: "IndexToDirect"
      Materials: *1 {
        a: 0
      }
    }
    Layer: 0 {
      Version: 100
      LayerElement:  {
        Type: "LayerElementNormal"
        TypedIndex: 0
      }
      LayerElement:  {
        Type: "LayerElementMaterial"
        TypedIndex: 0
      }
    }
  }
  Model: 1002, "Model::${mesh.name}", "Mesh" {
    Version: 232
    Properties70:  {
      P: "DefaultAttributeIndex", "int", "Integer", "",0
      P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
      P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
      P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
    }
    Shading: T
    Culling: "CullingOff"
  }
  Material: 1003, "Material::${mesh.name}_material", "" {
    Version: 102
    ShadingModel: "phong"
    MultiLayer: 0
    Properties70:  {
      P: "DiffuseColor", "Color", "", "A",${color.r.toFixed(6)},${color.g.toFixed(6)},${color.b.toFixed(6)}
    }
  }
}
Connections:  {
  C: "OO",1001,1002
  C: "OO",1002,0
  C: "OO",1003,1002
}
`;

  fs.writeFileSync(outPath, content);
}

function rotatePoint(point, yawDeg, pitchDeg) {
  const yaw = yawDeg * (Math.PI / 180);
  const pitch = pitchDeg * (Math.PI / 180);
  const [x, y, z] = point;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x1 = x * cosY - y * sinY;
  const y1 = x * sinY + y * cosY;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const y2 = y1 * cosP - z * sinP;
  const z2 = y1 * sinP + z * cosP;
  return [x1, y2, z2];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildBlenderStrategicViews(jobDir, scene, context, modelEntries = []) {
  const blenderPath = getBlenderPath();
  if (!blenderPath) return null;

  const preferredModel = (() => {
    const preferredRoles = context.modeling.modelScope === 'district' || context.modeling.includeMasterPlan
      ? ['master-scene', 'ai-individual-building', 'individual-building']
      : ['ai-individual-building', 'individual-building', 'master-scene'];

    for (const role of preferredRoles) {
      const match = (modelEntries || []).find(entry => entry.role === role && entry.glbPath && fs.existsSync(entry.glbPath));
      if (match) return match;
    }
    return (modelEntries || []).find(entry => entry.glbPath && fs.existsSync(entry.glbPath)) || null;
  })();

  if (!preferredModel) return null;

  const viewDefs = [
    { id: 'bird_nw', title: 'Bird Eye View', subtitle: 'Master scene bird-eye overview', yaw: -38, pitch: 42, distanceMultiplier: 2.45, width: 2200, height: 1400 },
    { id: 'bird_se', title: 'Bird Eye Alternate', subtitle: 'Opposite elevated angle', yaw: 138, pitch: 38, distanceMultiplier: 2.35, width: 2200, height: 1400 },
    { id: 'eye_street', title: 'Eye Level View', subtitle: 'Street-level architectural perspective', yaw: -18, pitch: 14, distanceMultiplier: 1.65, width: 2200, height: 1400 },
    { id: 'corner', title: 'Corner Perspective', subtitle: 'Facade and massing focus', yaw: -58, pitch: 20, distanceMultiplier: 1.82, width: 2200, height: 1400 },
    { id: 'top_plan', title: 'Top Plan', subtitle: 'Master plan composition', yaw: 0, pitch: 77, distanceMultiplier: 2.25, width: 2200, height: 1400 },
    { id: 'panorama', title: 'Panoramic Presentation', subtitle: 'Wide presentation strip', yaw: -26, pitch: 18, distanceMultiplier: 1.96, width: 3200, height: 1200 },
  ].slice(0, context.modeling.strategicViewCount).map(view => ({
    ...view,
    pngPath: path.join(jobDir, `${view.id}.png`),
    jpgPath: path.join(jobDir, `${view.id}.jpg`),
  }));

  const renderConfig = {
    glbPath: preferredModel.glbPath,
    sceneBounds: scene.bounds,
    outputDir: jobDir,
    samples: context.modeling.detailLevel === 'high' ? 96 : 64,
    views: viewDefs.map(view => ({
      id: view.id,
      yaw: view.yaw,
      pitch: view.pitch,
      distanceMultiplier: view.distanceMultiplier,
      width: view.width,
      height: view.height,
      pngPath: view.pngPath,
    })),
  };

  const configPath = path.join(jobDir, 'blender_render_config.json');
  const scriptPath = path.join(jobDir, 'service5_blender_render.py');
  fs.writeFileSync(configPath, JSON.stringify(renderConfig, null, 2));
  fs.writeFileSync(scriptPath, `
import bpy
import json
import math
import sys
from mathutils import Vector

def read_config():
    argv = sys.argv
    if '--' not in argv:
        raise RuntimeError('Missing config path')
    config_path = argv[argv.index('--') + 1]
    with open(config_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def set_view_look(scene, preferred_looks):
    for look_name in preferred_looks:
        try:
            scene.view_settings.look = look_name
            return
        except Exception:
            continue

def set_sky_type(sky_node, preferred_types):
    for sky_type in preferred_types:
        try:
            sky_node.sky_type = sky_type
            return
        except Exception:
            continue

def ensure_world():
    scene = bpy.context.scene
    world = bpy.data.worlds.new('Service05World')
    world.use_nodes = True
    scene.world = world
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    output = nodes.new(type='ShaderNodeOutputWorld')
    background = nodes.new(type='ShaderNodeBackground')
    background.inputs[0].default_value = (0.022, 0.037, 0.062, 1.0)
    background.inputs[1].default_value = 0.9
    sky = nodes.new(type='ShaderNodeTexSky')
    set_sky_type(sky, ['NISHITA', 'MULTIPLE_SCATTERING', 'HOSEK_WILKIE', 'PREETHAM'])
    if hasattr(sky, 'sun_elevation'):
        sky.sun_elevation = math.radians(38)
    if hasattr(sky, 'sun_rotation'):
        sky.sun_rotation = math.radians(126)
    if hasattr(sky, 'air_density'):
        sky.air_density = 1.2
    mix = nodes.new(type='ShaderNodeMixRGB')
    mix.blend_type = 'MIX'
    mix.inputs[0].default_value = 0.78
    links.new(sky.outputs[0], mix.inputs[1])
    links.new(background.outputs[0], output.inputs[0])
    links.new(mix.outputs[0], background.inputs[0])

def configure_render(samples):
    scene = bpy.context.scene
    try:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
    except Exception:
        scene.render.engine = 'BLENDER_EEVEE'
        scene.eevee.taa_render_samples = max(32, samples // 2)
        scene.eevee.use_gtao = True
        scene.eevee.use_bloom = True
        if hasattr(scene.eevee, 'use_ssr'):
            scene.eevee.use_ssr = True
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.resolution_percentage = 100
    set_view_look(scene, ['AgX - Medium High Contrast', 'Medium High Contrast', 'AgX - High Contrast', 'High Contrast', 'None'])
    scene.view_settings.exposure = 0.15
    scene.render.use_file_extension = True

def import_model(glb_path):
    bpy.ops.import_scene.gltf(filepath=glb_path)
    return [obj for obj in bpy.context.scene.objects if obj.type in {'MESH', 'EMPTY', 'CURVE', 'SURFACE', 'FONT'}]

def compute_bounds(objects):
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    for obj in objects:
        if obj.type != 'MESH':
            continue
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ Vector(corner)
            min_x = min(min_x, world_corner.x)
            min_y = min(min_y, world_corner.y)
            min_z = min(min_z, world_corner.z)
            max_x = max(max_x, world_corner.x)
            max_y = max(max_y, world_corner.y)
            max_z = max(max_z, world_corner.z)
    if min_x == float('inf'):
        min_x = min_y = min_z = -1.0
        max_x = max_y = max_z = 1.0
    return {
        'min_x': min_x, 'min_y': min_y, 'min_z': min_z,
        'max_x': max_x, 'max_y': max_y, 'max_z': max_z,
        'width': max_x - min_x, 'depth': max_y - min_y, 'height': max_z - min_z,
        'center': ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, (min_z + max_z) / 2.0),
    }

def add_lighting(bounds):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], bounds['height'], 6.0)

    sun_data = bpy.data.lights.new(name='Sun', type='SUN')
    sun_data.energy = 3.0
    sun_data.angle = math.radians(3.0)
    sun = bpy.data.objects.new('Sun', sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.location = (center[0] + span * 0.4, center[1] - span * 0.65, center[2] + span * 1.25)
    sun.rotation_euler = (math.radians(52), 0, math.radians(34))

    area_data = bpy.data.lights.new(name='AreaFill', type='AREA')
    area_data.energy = 2400
    area_data.shape = 'RECTANGLE'
    area_data.size = span * 0.8
    area_data.size_y = span * 0.45
    area = bpy.data.objects.new('AreaFill', area_data)
    bpy.context.scene.collection.objects.link(area)
    area.location = (center[0] - span * 0.85, center[1] - span * 0.45, center[2] + span * 0.7)
    area.rotation_euler = (math.radians(66), 0, math.radians(-58))

def add_ground(bounds):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], 6.0)
    bpy.ops.mesh.primitive_plane_add(size=span * 3.4, location=(center[0], center[1], bounds['min_z'] - 0.03))
    plane = bpy.context.active_object
    mat = bpy.data.materials.new(name='Ground')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (0.69, 0.66, 0.61, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.92
        if 'Specular IOR Level' in bsdf.inputs:
            bsdf.inputs['Specular IOR Level'].default_value = 0.22
        elif 'Specular' in bsdf.inputs:
            bsdf.inputs['Specular'].default_value = 0.22
    plane.data.materials.append(mat)

def build_camera(bounds):
    camera_data = bpy.data.cameras.new('Service05Camera')
    camera_data.lens = 42
    camera_data.sensor_width = 36
    camera = bpy.data.objects.new('Service05Camera', camera_data)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    target = bpy.data.objects.new('Service05Target', None)
    target.empty_display_type = 'PLAIN_AXES'
    target.location = bounds['center']
    bpy.context.scene.collection.objects.link(target)

    constraint = camera.constraints.new(type='TRACK_TO')
    constraint.target = target
    constraint.track_axis = 'TRACK_NEGATIVE_Z'
    constraint.up_axis = 'UP_Y'
    return camera, target

def place_camera(camera, target, bounds, yaw_deg, pitch_deg, distance_multiplier):
    center = bounds['center']
    target.location = (center[0], center[1], center[2] + bounds['height'] * 0.22)
    span = max(bounds['width'], bounds['depth'], bounds['height'], 5.0)
    distance = span * distance_multiplier
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    x = center[0] + distance * math.cos(pitch) * math.sin(yaw)
    y = center[1] + distance * math.cos(pitch) * math.cos(yaw)
    z = center[2] + distance * math.sin(pitch) + bounds['height'] * 0.18
    camera.location = (x, y, z)

def main():
    config = read_config()
    clear_scene()
    ensure_world()
    configure_render(int(config.get('samples', 64)))
    imported = import_model(config['glbPath'])
    bounds = compute_bounds(imported)
    add_ground(bounds)
    add_lighting(bounds)
    camera, target = build_camera(bounds)
    scene = bpy.context.scene

    for view in config['views']:
        scene.render.resolution_x = int(view['width'])
        scene.render.resolution_y = int(view['height'])
        place_camera(camera, target, bounds, float(view['yaw']), float(view['pitch']), float(view['distanceMultiplier']))
        scene.render.filepath = view['pngPath']
        bpy.ops.render.render(write_still=True)

main()
`.trim());

  return { blenderPath, preferredModel, viewDefs, configPath, scriptPath };
}

async function tryRenderStrategicViewsWithBlender(jobDir, scene, context, modelEntries = []) {
  const renderJob = buildBlenderStrategicViews(jobDir, scene, context, modelEntries);
  if (!renderJob) return null;

  try {
    const result = await execFileAsync(renderJob.blenderPath, [
      '--background',
      '--factory-startup',
      '--python', renderJob.scriptPath,
      '--',
      renderJob.configPath,
    ], {
      cwd: jobDir,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });

    const outputs = [];
    for (const view of renderJob.viewDefs) {
      if (!fs.existsSync(view.pngPath)) {
        throw new Error(`Blender did not create ${path.basename(view.pngPath)}`);
      }
      await sharp(view.pngPath)
        .jpeg({ quality: 96, chromaSubsampling: '4:4:4' })
        .toFile(view.jpgPath);

      outputs.push({
        ...view,
        svgPath: '',
        renderMode: 'blender-glb',
        sourceModel: path.basename(renderJob.preferredModel.glbPath),
      });
    }

    return outputs;
  } catch (error) {
    return null;
  }
}

async function enhanceRenderedImage(pngPath, jpgPath, renderPreset, enableEnhancement) {
  let pipeline = sharp(pngPath).rotate();

  if (enableEnhancement) {
    pipeline = pipeline
      .modulate({
        brightness: renderPreset === 'night' ? 1.03 : 1.01,
        saturation: renderPreset === 'golden_hour' ? 1.08 : renderPreset === 'night' ? 1.05 : 1.03,
      })
      .sharpen({ sigma: 1.2, flat: 1.08, jagged: 2.4 });
  }

  const pngBuffer = await pipeline
    .withMetadata()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  fs.writeFileSync(pngPath, pngBuffer);

  await sharp(pngBuffer)
    .jpeg({
      quality: enableEnhancement ? 97 : 95,
      chromaSubsampling: '4:4:4',
    })
    .toFile(jpgPath);

  return { enhanced: Boolean(enableEnhancement) };
}

function buildStrategicRenderPlan(jobDir, context, modelEntries = []) {
  const preferredModel = (() => {
    const preferredRoles = context.modeling.modelScope === 'district' || context.modeling.includeMasterPlan
      ? ['master-scene', 'ai-individual-building', 'individual-building']
      : ['ai-individual-building', 'individual-building', 'master-scene'];
    for (const role of preferredRoles) {
      const match = (modelEntries || []).find(entry => entry.role === role && entry.glbPath && fs.existsSync(entry.glbPath));
      if (match) return match;
    }
    return (modelEntries || []).find(entry => entry.glbPath && fs.existsSync(entry.glbPath)) || null;
  })();
  if (!preferredModel) return null;

  const primaryStyle = normalizeText(context.project.architecturalStyle, context.targetBuildings[0]?.style || 'Traditional heritage');
  const materialProfile = materialProfileFromStyle(primaryStyle);
  const palette = colorFromStyle(primaryStyle);
  const samples = context.modeling.renderQuality === 'ultra'
    ? 160
    : context.modeling.renderQuality === 'high'
      ? 112
      : 72;

  const viewDefs = BLENDER_VIEW_TEMPLATES
    .slice(0, context.modeling.strategicViewCount)
    .map(view => ({
      ...view,
      pngPath: path.join(jobDir, `${view.fileBase || view.id}.png`),
      jpgPath: path.join(jobDir, `${view.fileBase || view.id}.jpg`),
    }));

  return {
    preferredModel,
    primaryStyle,
    materialProfile,
    palette,
    samples,
    viewDefs,
  };
}

function buildBlenderStrategicViews(jobDir, scene, context, modelEntries = []) {
  const blenderPath = getBlenderPath();
  if (!blenderPath) return null;
  const plan = buildStrategicRenderPlan(jobDir, context, modelEntries);
  if (!plan) return null;
  const { preferredModel, primaryStyle, materialProfile, palette, samples, viewDefs } = plan;

  const renderConfig = {
    glbPath: preferredModel.glbPath,
    hdriPath: context.modeling.hdriPath || '',
    project: {
      title: context.project.title,
      style: primaryStyle,
      buildingName: context.project.buildingName,
    },
    modelScope: context.modeling.modelScope,
    includeTerrain: context.modeling.includeTerrain,
    includeMasterPlan: context.modeling.includeMasterPlan,
    generationMode: context.modeling.generationMode,
    preserveDistrictContext: Boolean(getSpatialContext(context))
      || context.modeling.modelScope === 'district'
      || context.modeling.includeMasterPlan,
    renderStyle: context.modeling.renderStyle,
    renderQuality: context.modeling.renderQuality,
    samples,
    lightingPresets: RENDER_LIGHTING_PRESETS,
    materialProfile: {
      ...materialProfile,
      base_r: hexToRgb01(materialProfile.base).r,
      base_g: hexToRgb01(materialProfile.base).g,
      base_b: hexToRgb01(materialProfile.base).b,
      accent_r: hexToRgb01(materialProfile.accent).r,
      accent_g: hexToRgb01(materialProfile.accent).g,
      accent_b: hexToRgb01(materialProfile.accent).b,
    },
    palette: {
      base_r: hexToRgb01(palette.base).r,
      base_g: hexToRgb01(palette.base).g,
      base_b: hexToRgb01(palette.base).b,
      accent_r: hexToRgb01(palette.accent).r,
      accent_g: hexToRgb01(palette.accent).g,
      accent_b: hexToRgb01(palette.accent).b,
      roof_r: hexToRgb01(palette.roof).r,
      roof_g: hexToRgb01(palette.roof).g,
      roof_b: hexToRgb01(palette.roof).b,
    },
    views: viewDefs.map(view => ({
      id: view.id,
      title: view.title,
      subtitle: view.subtitle,
      cameraType: view.cameraType,
      preset: view.preset,
      focalLength: view.focalLength,
      width: view.width,
      height: view.height,
      pngPath: view.pngPath,
    })),
  };

  const configPath = path.join(jobDir, 'blender_render_config.json');
  const scriptPath = path.join(jobDir, 'service5_blender_render.py');
  fs.writeFileSync(configPath, JSON.stringify(renderConfig, null, 2));
  fs.writeFileSync(scriptPath, `
import bpy
import json
import math
import os
import sys
from mathutils import Vector

CAMERA_PRESETS = {
    'front': {'yaw': 180, 'pitch': 10, 'distance': 1.08, 'target_height': 0.42},
    'bird': {'yaw': -34, 'pitch': 44, 'distance': 1.55, 'target_height': 0.34},
    'aerial_alt': {'yaw': 132, 'pitch': 38, 'distance': 1.62, 'target_height': 0.34},
    'eye': {'yaw': -20, 'pitch': 15, 'distance': 1.22, 'target_height': 0.36},
    'corner': {'yaw': -56, 'pitch': 20, 'distance': 1.28, 'target_height': 0.36},
    'night': {'yaw': -8, 'pitch': 12, 'distance': 1.16, 'target_height': 0.40},
}

def read_config():
    argv = sys.argv
    if '--' not in argv:
        raise RuntimeError('Missing config path')
    config_path = argv[argv.index('--') + 1]
    with open(config_path, 'r', encoding='utf-8') as handle:
        return json.load(handle)

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def rgb(r, g, b, a=1.0):
    return (float(r), float(g), float(b), float(a))

def tone(color_tuple, factor):
    return tuple(max(0.0, min(1.0, channel * factor)) for channel in color_tuple[:3])

def set_view_look(scene, preferred_looks):
    for look_name in preferred_looks:
        try:
            scene.view_settings.look = look_name
            return
        except Exception:
            continue

def set_sky_type(sky_node, preferred_types):
    for sky_type in preferred_types:
        try:
            sky_node.sky_type = sky_type
            return
        except Exception:
            continue

def set_material(obj, color, roughness, metallic=0.0, transmission=0.0):
    mat = bpy.data.materials.new(name=f'{obj.name}_mat')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = color
        bsdf.inputs['Roughness'].default_value = roughness
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = metallic
        if 'Transmission Weight' in bsdf.inputs:
            bsdf.inputs['Transmission Weight'].default_value = transmission
        elif 'Transmission' in bsdf.inputs:
            bsdf.inputs['Transmission'].default_value = transmission
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)

def classify_material(name, config):
    lower = name.lower()
    profile = config['materialProfile']
    palette = config['palette']
    base_color = rgb(palette['base_r'] * 0.52, palette['base_g'] * 0.52, palette['base_b'] * 0.52)
    accent_color = rgb(palette['accent_r'] * 0.68, palette['accent_g'] * 0.68, palette['accent_b'] * 0.68)
    roof_color = rgb(palette['roof_r'] * 0.60, palette['roof_g'] * 0.60, palette['roof_b'] * 0.60)
    if 'glass' in lower or 'window' in lower:
        return rgb(0.52, 0.61, 0.70), 0.14, 0.0, 0.18
    if 'roof' in lower or 'parapet' in lower:
        return roof_color, 0.68, 0.02, 0.0
    if 'door' in lower or 'wood' in lower or profile['label'] == 'Wood':
        return rgb(profile['accent_r'] * 0.72, profile['accent_g'] * 0.72, profile['accent_b'] * 0.72), 0.68, 0.02, 0.0
    if 'street' in lower or 'public' in lower or 'terrain' in lower or 'plot' in lower:
        return rgb(0.30, 0.30, 0.29), 0.96, 0.0, 0.0
    if 'band' in lower or 'arch' in lower or 'detail' in lower or 'facade' in lower:
        return accent_color, max(0.56, profile['roughness'] - 0.04), 0.0, 0.0
    return base_color, max(0.64, profile['roughness']), 0.0, 0.0

def style_model_objects(objects, config):
    for obj in objects:
        if obj.type != 'MESH':
            continue
        color, roughness, metallic, transmission = classify_material(obj.name, config)
        set_material(obj, color, roughness, metallic, transmission)

def configure_render(config):
    scene = bpy.context.scene
    samples = int(config.get('samples', 96))
    try:
        scene.render.engine = 'CYCLES'
        scene.cycles.samples = samples
        scene.cycles.preview_samples = max(24, samples // 3)
        scene.cycles.use_denoising = True
        if hasattr(scene.cycles, 'use_adaptive_sampling'):
            scene.cycles.use_adaptive_sampling = True
        if hasattr(scene.cycles, 'sample_clamp_direct'):
            scene.cycles.sample_clamp_direct = 2.0
        if hasattr(scene.cycles, 'sample_clamp_indirect'):
            scene.cycles.sample_clamp_indirect = 1.2
    except Exception:
        scene.render.engine = 'BLENDER_EEVEE'
        scene.eevee.taa_render_samples = max(32, samples // 2)
        scene.eevee.use_gtao = True
        scene.eevee.use_bloom = True
        if hasattr(scene.eevee, 'use_ssr'):
            scene.eevee.use_ssr = True
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.render.use_persistent_data = True
    set_view_look(scene, ['AgX - Medium High Contrast', 'Medium High Contrast', 'AgX - High Contrast', 'High Contrast', 'None'])
    scene.view_settings.exposure = -0.25

def import_model(glb_path):
    bpy.ops.import_scene.gltf(filepath=glb_path)
    return [obj for obj in bpy.context.scene.objects if obj.type in {'MESH', 'EMPTY', 'CURVE', 'SURFACE', 'FONT'}]

def object_bounds(obj):
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    for corner in obj.bound_box:
        world_corner = obj.matrix_world @ Vector(corner)
        min_x = min(min_x, world_corner.x)
        min_y = min(min_y, world_corner.y)
        min_z = min(min_z, world_corner.z)
        max_x = max(max_x, world_corner.x)
        max_y = max(max_y, world_corner.y)
        max_z = max(max_z, world_corner.z)
    return {
        'min_x': min_x, 'min_y': min_y, 'min_z': min_z,
        'max_x': max_x, 'max_y': max_y, 'max_z': max_z,
        'width': max_x - min_x, 'depth': max_y - min_y, 'height': max_z - min_z,
        'center': ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, (min_z + max_z) / 2.0),
    }

def object_metric(obj):
    bounds = object_bounds(obj)
    footprint = max(bounds['width'], 0.01) * max(bounds['depth'], 0.01)
    volume = footprint * max(bounds['height'], 0.01)
    diagonal = math.sqrt(bounds['width'] ** 2 + bounds['depth'] ** 2 + bounds['height'] ** 2)
    return {
        'object': obj,
        'bounds': bounds,
        'footprint': footprint,
        'volume': volume,
        'diagonal': diagonal,
    }

def distance_2d(a, b):
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

def prune_imported_objects(imported_objects, config):
    mesh_metrics = [object_metric(obj) for obj in imported_objects if obj.type == 'MESH']
    if len(mesh_metrics) <= 1:
        return imported_objects

    preserve_context = bool(config.get('preserveDistrictContext')) or config.get('modelScope') == 'district'
    if preserve_context:
        return imported_objects

    ranked = sorted(mesh_metrics, key=lambda item: item['volume'], reverse=True)
    primary = ranked[0]
    primary_center = primary['bounds']['center']
    primary_span = max(primary['bounds']['width'], primary['bounds']['depth'], primary['bounds']['height'], 1.0)

    kept_mesh_names = set()
    for metric in ranked:
        dist = distance_2d(metric['bounds']['center'], primary_center)
        keep_large = metric['volume'] >= primary['volume'] * 0.08
        keep_close = dist <= max(primary_span * 1.35, 4.0)
        overlap_x = abs(metric['bounds']['center'][0] - primary_center[0]) <= max(primary['bounds']['width'], 1.0) * 0.95
        if keep_close or (keep_large and overlap_x):
            kept_mesh_names.add(metric['object'].name)
    kept_mesh_names.add(primary['object'].name)

    for obj in imported_objects:
        if obj.type == 'MESH' and obj.name not in kept_mesh_names:
            bpy.data.objects.remove(obj, do_unlink=True)

    return [obj for obj in bpy.context.scene.objects if obj.type in {'MESH', 'EMPTY', 'CURVE', 'SURFACE', 'FONT'}]

def compute_bounds(objects):
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    for obj in objects:
        if obj.type != 'MESH':
            continue
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ Vector(corner)
            min_x = min(min_x, world_corner.x)
            min_y = min(min_y, world_corner.y)
            min_z = min(min_z, world_corner.z)
            max_x = max(max_x, world_corner.x)
            max_y = max(max_y, world_corner.y)
            max_z = max(max_z, world_corner.z)
    if min_x == float('inf'):
        min_x = min_y = min_z = -1.0
        max_x = max_y = max_z = 1.0
    return {
        'min_x': min_x, 'min_y': min_y, 'min_z': min_z,
        'max_x': max_x, 'max_y': max_y, 'max_z': max_z,
        'width': max_x - min_x, 'depth': max_y - min_y, 'height': max_z - min_z,
        'center': ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, (min_z + max_z) / 2.0),
    }

def remove_tagged(prefix):
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith(prefix):
            bpy.data.objects.remove(obj, do_unlink=True)

def ensure_world(config, preset):
    scene = bpy.context.scene
    world = bpy.data.worlds.new('Service05World')
    world.use_nodes = True
    scene.world = world
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    nodes.clear()
    output = nodes.new(type='ShaderNodeOutputWorld')
    background = nodes.new(type='ShaderNodeBackground')
    background.inputs[1].default_value = float(preset.get('worldStrength', 1.0))
    hdri_path = config.get('hdriPath') or ''
    if hdri_path and os.path.exists(hdri_path):
        env = nodes.new(type='ShaderNodeTexEnvironment')
        env.image = bpy.data.images.load(hdri_path)
        links.new(env.outputs[0], background.inputs[0])
    else:
        sky = nodes.new(type='ShaderNodeTexSky')
        set_sky_type(sky, ['NISHITA', 'MULTIPLE_SCATTERING', 'HOSEK_WILKIE', 'PREETHAM'])
        if hasattr(sky, 'sun_elevation'):
            sky.sun_elevation = math.radians(float(preset.get('sunElevation', 38)))
        if hasattr(sky, 'sun_rotation'):
            sky.sun_rotation = math.radians(float(preset.get('sunRotation', 126)))
        if hasattr(sky, 'air_density'):
            sky.air_density = 1.3
        if hasattr(sky, 'dust_density'):
            sky.dust_density = 2.4 if preset.get('label') == 'Golden Hour' else 1.0
        links.new(sky.outputs[0], background.inputs[0])
    links.new(background.outputs[0], output.inputs[0])

def add_lighting(bounds, preset):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], bounds['height'], 6.0)
    sun_data = bpy.data.lights.new(name='Service05Sun', type='SUN')
    sun_data.energy = float(preset.get('sunEnergy', 3.0))
    sun_data.angle = math.radians(1.8 if preset.get('label') == 'Night' else 2.8)
    sun = bpy.data.objects.new('Service05Sun', sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.location = (center[0] + span * 0.45, center[1] - span * 0.72, center[2] + span * 1.3)
    sun.rotation_euler = (math.radians(90 - float(preset.get('sunElevation', 38))), 0, math.radians(34))
    area_data = bpy.data.lights.new(name='Service05Fill', type='AREA')
    area_data.energy = float(preset.get('fillEnergy', 1800))
    area_data.shape = 'RECTANGLE'
    area_data.size = span * 0.55
    area_data.size_y = span * 0.28
    area = bpy.data.objects.new('Service05Fill', area_data)
    bpy.context.scene.collection.objects.link(area)
    area.location = (center[0] - span * 0.55, center[1] - span * 0.25, center[2] + span * 0.48)
    area.rotation_euler = (math.radians(74), 0, math.radians(-46))
    if preset.get('label') == 'Night':
        for index, offset in enumerate((-0.42, 0.0, 0.42), start=1):
            point_data = bpy.data.lights.new(name=f'Service05Facade{index}', type='POINT')
            point_data.energy = 180
            point_data.color = (1.0, 0.78, 0.58)
            point = bpy.data.objects.new(f'Service05Facade{index}', point_data)
            bpy.context.scene.collection.objects.link(point)
            point.location = (center[0] + span * offset * 0.32, center[1] - span * 0.5, center[2] + bounds['height'] * 0.48)

def add_ground(bounds, config):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], 6.0)
    site_scale = 1.45 if config.get('modelScope') == 'district' else 0.92
    bpy.ops.mesh.primitive_plane_add(size=span * site_scale, location=(center[0], center[1], bounds['min_z'] - 0.02))
    plane = bpy.context.active_object
    plane.name = 'Service05Ground'
    set_material(plane, rgb(0.34, 0.34, 0.33), 0.98)
    if config.get('modelScope') == 'district':
        bpy.ops.mesh.primitive_plane_add(size=span * 0.88, location=(center[0], center[1], bounds['min_z'] - 0.012))
        plaza = bpy.context.active_object
        plaza.name = 'Service05Plaza'
        plaza.scale = (1.0, 0.26, 1.0)
        set_material(plaza, rgb(0.28, 0.28, 0.27), 0.92)
    else:
        bpy.ops.mesh.primitive_plane_add(size=span * 0.72, location=(center[0], center[1], bounds['min_z'] - 0.01))
        platform = bpy.context.active_object
        platform.name = 'Service05Platform'
        platform.scale = (1.0, 0.54, 1.0)
        set_material(platform, rgb(0.42, 0.40, 0.37), 0.90)

def add_palm(location, scale_factor):
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.08 * scale_factor, depth=1.2 * scale_factor, location=(location[0], location[1], location[2] + 0.6 * scale_factor))
    trunk = bpy.context.active_object
    set_material(trunk, rgb(0.44, 0.31, 0.21), 0.88)
    for angle in (0, 72, 144, 216, 288):
        bpy.ops.mesh.primitive_plane_add(size=0.52 * scale_factor, location=(location[0], location[1], location[2] + 1.18 * scale_factor))
        leaf = bpy.context.active_object
        leaf.rotation_euler = (math.radians(68), 0, math.radians(angle))
        leaf.scale = (1.55, 0.18, 1.0)
        set_material(leaf, rgb(0.30, 0.45, 0.24), 0.82)

def add_planter(location, scale_factor):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.18 * scale_factor, depth=0.22 * scale_factor, location=(location[0], location[1], location[2] + 0.11 * scale_factor))
    planter = bpy.context.active_object
    set_material(planter, rgb(0.56, 0.46, 0.38), 0.70)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.16 * scale_factor, location=(location[0], location[1], location[2] + 0.3 * scale_factor))
    plant = bpy.context.active_object
    plant.scale = (1.0, 1.0, 1.35)
    set_material(plant, rgb(0.33, 0.50, 0.29), 0.86)

def add_human_scale(bounds):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], 6.0)
    for offset in (-0.18, 0.16):
        bpy.ops.mesh.primitive_cylinder_add(vertices=14, radius=0.08, depth=1.62, location=(center[0] + span * offset, center[1] - span * 0.42, bounds['min_z'] + 0.81))
        body = bpy.context.active_object
        set_material(body, rgb(0.18, 0.20, 0.23), 0.76)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.11, location=(center[0] + span * offset, center[1] - span * 0.42, bounds['min_z'] + 1.70))
        head = bpy.context.active_object
        set_material(head, rgb(0.71, 0.59, 0.49), 0.62)

def add_context(bounds, config):
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], 6.0)
    scale_factor = max(0.85, span / 18.0)
    if config.get('modelScope') == 'district':
        add_palm((center[0] - span * 0.42, center[1] + span * 0.34, bounds['min_z']), scale_factor)
        add_palm((center[0] + span * 0.44, center[1] - span * 0.30, bounds['min_z']), scale_factor * 0.95)
        add_planter((center[0] - span * 0.14, center[1] - span * 0.36, bounds['min_z']), scale_factor)
        add_planter((center[0] + span * 0.18, center[1] - span * 0.34, bounds['min_z']), scale_factor)
    else:
        add_planter((center[0] - span * 0.18, center[1] - span * 0.24, bounds['min_z']), scale_factor * 0.7)
        add_planter((center[0] + span * 0.18, center[1] - span * 0.24, bounds['min_z']), scale_factor * 0.7)
    add_human_scale(bounds)

def configure_compositor(preset):
    scene = bpy.context.scene
    if hasattr(scene, 'use_nodes'):
        scene.use_nodes = True
    tree = scene.node_tree if hasattr(scene, 'node_tree') else getattr(scene, 'compositing_node_tree', None)
    if tree is None:
        return
    nodes = tree.nodes
    links = tree.links
    nodes.clear()
    render_layers = nodes.new(type='CompositorNodeRLayers')
    color_balance = nodes.new(type='CompositorNodeColorBalance')
    color_balance.gamma = (0.98, 0.98, 0.98)
    color_balance.gain = (0.97, 0.97, 0.97)
    bright = nodes.new(type='CompositorNodeBrightContrast')
    bright.inputs['Bright'].default_value = 0.12 if preset.get('label') == 'Night' else -0.08
    bright.inputs['Contrast'].default_value = 2.2 if preset.get('label') == 'Night' else 1.1
    glare = nodes.new(type='CompositorNodeGlare')
    glare.glare_type = 'FOG_GLOW'
    glare.threshold = 1.2 if preset.get('bloom') else 100.0
    glare.size = 4
    composite = nodes.new(type='CompositorNodeComposite')
    links.new(render_layers.outputs['Image'], color_balance.inputs['Image'])
    links.new(color_balance.outputs['Image'], bright.inputs['Image'])
    links.new(bright.outputs['Image'], glare.inputs['Image'])
    links.new(glare.outputs['Image'], composite.inputs['Image'])

def build_camera():
    camera_data = bpy.data.cameras.new('Service05Camera')
    camera_data.lens = 50
    camera_data.sensor_width = 36
    camera = bpy.data.objects.new('Service05Camera', camera_data)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    target = bpy.data.objects.new('Service05Target', None)
    target.empty_display_type = 'PLAIN_AXES'
    bpy.context.scene.collection.objects.link(target)
    constraint = camera.constraints.new(type='TRACK_TO')
    constraint.target = target
    constraint.track_axis = 'TRACK_NEGATIVE_Z'
    constraint.up_axis = 'UP_Y'
    return camera, target

def place_camera(camera, target, bounds, view):
    preset = CAMERA_PRESETS.get(view['cameraType'], CAMERA_PRESETS['corner'])
    center = bounds['center']
    span = max(bounds['width'], bounds['depth'], bounds['height'], 5.0)
    target.location = (center[0], center[1], center[2] + bounds['height'] * preset['target_height'])
    distance = span * preset['distance']
    yaw = math.radians(preset['yaw'])
    pitch = math.radians(preset['pitch'])
    x = center[0] + distance * math.cos(pitch) * math.sin(yaw)
    y = center[1] + distance * math.cos(pitch) * math.cos(yaw)
    z = center[2] + distance * math.sin(pitch) + bounds['height'] * 0.12
    camera.location = (x, y, z)
    camera.data.lens = float(view.get('focalLength', 50))
    camera.data.clip_end = span * 30

def apply_preset(config, bounds, preset_name):
    preset = config['lightingPresets'].get(preset_name, config['lightingPresets']['daylight'])
    bpy.context.scene.view_settings.exposure = float(preset.get('exposure', 0.2))
    ensure_world(config, preset)
    add_lighting(bounds, preset)
    configure_compositor(preset)

def main():
    config = read_config()
    clear_scene()
    configure_render(config)
    imported = import_model(config['glbPath'])
    imported = prune_imported_objects(imported, config)
    bounds = compute_bounds(imported)
    style_model_objects(imported, config)
    add_ground(bounds, config)
    add_context(bounds, config)
    scene = bpy.context.scene
    for view in config['views']:
        remove_tagged('Service05Sun')
        remove_tagged('Service05Fill')
        remove_tagged('Service05Facade')
        remove_tagged('Service05Camera')
        remove_tagged('Service05Target')
        camera, target = build_camera()
        apply_preset(config, bounds, view['preset'])
        scene.render.resolution_x = int(view['width'])
        scene.render.resolution_y = int(view['height'])
        place_camera(camera, target, bounds, view)
        scene.render.filepath = view['pngPath']
        bpy.ops.render.render(write_still=True)

main()
`.trim());

  return { blenderPath, preferredModel, viewDefs, configPath, scriptPath };
}

async function tryRenderStrategicViewsWithBlender(jobDir, scene, context, modelEntries = []) {
  const renderJob = buildBlenderStrategicViews(jobDir, scene, context, modelEntries);
  if (!renderJob) return null;

  try {
    await execFileAsync(renderJob.blenderPath, [
      '--background',
      '--factory-startup',
      '--python', renderJob.scriptPath,
      '--',
      renderJob.configPath,
    ], {
      cwd: jobDir,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });

    const outputs = [];
    for (const view of renderJob.viewDefs) {
      if (!fs.existsSync(view.pngPath)) {
        throw new Error(`Blender did not create ${path.basename(view.pngPath)}`);
      }

      const enhancement = await enhanceRenderedImage(
        view.pngPath,
        view.jpgPath,
        view.preset,
        context.modeling.enablePostEnhancement
      );

      outputs.push({
        ...view,
        svgPath: '',
        renderMode: 'blender-official',
        sourceModel: path.basename(renderJob.preferredModel.glbPath),
        renderPreset: view.preset,
        enhanced: enhancement.enhanced,
      });
    }

    return outputs;
  } catch (error) {
    const detail = compactText(
      error.stderr || error.stdout || error.message || 'Unknown Blender render failure.',
      1200
    );
    throw new Error(`Blender official render failed: ${detail}`);
  }
}

function buildThreeJsStrategicViews(jobDir, scene, context, modelEntries = []) {
  const browserPath = getHeadlessBrowserPath();
  if (!browserPath) return null;

  const plan = buildStrategicRenderPlan(jobDir, context, modelEntries);
  if (!plan) return null;

  const { preferredModel, primaryStyle, materialProfile, palette, viewDefs } = plan;
  const renderHtmlPath = path.join(jobDir, 'three_render_capture.html');
  const baseUrl = normalizeText(context.runtime?.appBaseUrl, APP_BASE_URL).replace(/\/+$/, '');
  const jobId = path.basename(jobDir);
  const materialHex = {
    base: materialProfile.base,
    accent: materialProfile.accent,
    paletteBase: palette.base,
    paletteAccent: palette.accent,
    paletteRoof: palette.roof,
    paletteDetail: palette.detail,
  };
  const renderConfig = {
    projectTitle: context.project.title,
    modelScope: context.modeling.modelScope,
    renderStyle: context.modeling.renderStyle,
    renderQuality: context.modeling.renderQuality,
    style: primaryStyle,
    glbFile: path.basename(preferredModel.glbPath),
    materialHex,
    lightingPresets: RENDER_LIGHTING_PRESETS,
    views: viewDefs.map(view => ({
      id: view.id,
      title: view.title,
      subtitle: view.subtitle,
      cameraType: view.cameraType,
      preset: view.preset,
      width: view.width,
      height: view.height,
      focalLength: view.focalLength,
      pngPath: view.pngPath,
      jpgPath: view.jpgPath,
    })),
  };
  const encodedConfig = JSON.stringify(renderConfig);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${context.project.title} - Strategic Render Capture</title>
  <script type="importmap">
    {
      "imports": {
        "three": "/vendor/three/build/three.module.js",
        "three/addons/": "/vendor/three/examples/jsm/"
      }
    }
  </script>
  <style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:radial-gradient(circle at top,#253d58 0,#0a1420 70%)}
    canvas{display:block;width:100%;height:100%}
    #status{position:fixed;left:16px;bottom:14px;padding:8px 12px;border-radius:999px;background:rgba(8,18,28,.72);border:1px solid rgba(255,255,255,.08);color:#d9e3ef;font:12px Arial,sans-serif;letter-spacing:.03em}
  </style>
</head>
<body>
  <div id="status">loading</div>
  <script type="module">
    const config = ${encodedConfig};
    const params = new URLSearchParams(window.location.search);
    const viewId = params.get('view') || config.views[0]?.id;
    const view = config.views.find(item => item.id === viewId) || config.views[0];
    const statusEl = document.getElementById('status');
    const CAMERA_PRESETS = {
      front: { yaw: 180, pitch: 10, distance: 1.44, targetHeight: 0.34 },
      bird: { yaw: -36, pitch: 38, distance: 1.92, targetHeight: 0.28 },
      aerial_alt: { yaw: 136, pitch: 34, distance: 1.88, targetHeight: 0.28 },
      eye: { yaw: -18, pitch: 14, distance: 1.48, targetHeight: 0.31 },
      corner: { yaw: -56, pitch: 18, distance: 1.56, targetHeight: 0.31 },
      night: { yaw: -8, pitch: 12, distance: 1.34, targetHeight: 0.36 },
    };

    try {
      const [THREE, controlsModule, loaderModule] = await Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/loaders/GLTFLoader.js'),
      ]);
      const { OrbitControls } = controlsModule;
      const { GLTFLoader } = loaderModule;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setSize(view.width, view.height);
      renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = view.preset === 'night' ? 1.06 : view.preset === 'golden_hour' ? 1.1 : 1.0;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      document.body.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(view.preset === 'night' ? '#09111b' : view.preset === 'golden_hour' ? '#16263a' : '#122238');
      scene.fog = new THREE.Fog(scene.background, 90, 260);

      const camera = new THREE.PerspectiveCamera(40, view.width / view.height, 0.1, 5000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.enablePan = false;

    function hexColor(value) {
      return new THREE.Color(value || '#c3ab8f');
    }

    function makeMaterial(kind) {
      if (kind === 'glass') {
        return new THREE.MeshPhysicalMaterial({
          color: '#a9c4d7',
          roughness: 0.14,
          metalness: 0.0,
          transmission: 0.34,
          transparent: true,
          opacity: 0.92,
        });
      }
      if (kind === 'roof') {
        return new THREE.MeshStandardMaterial({ color: hexColor(config.materialHex.paletteRoof), roughness: 0.72, metalness: 0.04 });
      }
      if (kind === 'detail') {
        return new THREE.MeshStandardMaterial({ color: hexColor(config.materialHex.paletteAccent), roughness: 0.62, metalness: 0.02 });
      }
      if (kind === 'ground') {
        return new THREE.MeshStandardMaterial({ color: '#c8baa5', roughness: 0.96, metalness: 0.0 });
      }
      if (kind === 'paving') {
        return new THREE.MeshStandardMaterial({ color: '#8b775f', roughness: 0.9, metalness: 0.0 });
      }
      return new THREE.MeshStandardMaterial({ color: hexColor(config.materialHex.paletteBase), roughness: 0.78, metalness: 0.02 });
    }

    function classifyMesh(name) {
      const lower = String(name || '').toLowerCase();
      if (lower.includes('window')) return 'glass';
      if (lower.includes('roof') || lower.includes('parapet')) return 'roof';
      if (lower.includes('arch') || lower.includes('band') || lower.includes('door') || lower.includes('detail')) return 'detail';
      return 'body';
    }

    function styleModel(root) {
      root.traverse(object => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
        const kind = classifyMesh(object.name);
        if (Array.isArray(object.material)) {
          object.material = object.material.map(material => {
            if (material && material.map) {
              material.roughness = Math.min(material.roughness ?? 1, 0.86);
              material.metalness = 0.02;
              return material;
            }
            return makeMaterial(kind);
          });
        } else if (object.material && object.material.map) {
          object.material.roughness = Math.min(object.material.roughness ?? 1, 0.86);
          object.material.metalness = 0.02;
        } else {
          object.material = makeMaterial(kind);
        }
      });
    }

    function addGround(box) {
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const span = Math.max(size.x, size.z, 12);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * (config.modelScope === 'district' ? 2.2 : 1.5), span * (config.modelScope === 'district' ? 1.8 : 1.22)), makeMaterial('ground'));
      ground.rotation.x = -Math.PI / 2;
      ground.position.set(center.x, box.min.y - 0.02, center.z);
      ground.receiveShadow = true;
      scene.add(ground);

      const plaza = new THREE.Mesh(new THREE.PlaneGeometry(span * 0.96, span * (config.modelScope === 'district' ? 0.42 : 0.66)), makeMaterial('paving'));
      plaza.rotation.x = -Math.PI / 2;
      plaza.position.set(center.x, box.min.y - 0.012, center.z + span * (config.modelScope === 'district' ? -0.05 : 0.03));
      plaza.receiveShadow = true;
      scene.add(plaza);
    }

    function addPlanter(position, scale = 1) {
      const planter = new THREE.Mesh(new THREE.CylinderGeometry(0.34 * scale, 0.38 * scale, 0.22 * scale, 16), new THREE.MeshStandardMaterial({ color: '#8d7258', roughness: 0.74 }));
      planter.position.copy(position);
      planter.castShadow = true;
      planter.receiveShadow = true;
      scene.add(planter);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(0.28 * scale, 16, 16), new THREE.MeshStandardMaterial({ color: '#4f6e3e', roughness: 0.86 }));
      crown.scale.set(1, 1.25, 1);
      crown.position.set(position.x, position.y + 0.32 * scale, position.z);
      crown.castShadow = true;
      scene.add(crown);
    }

    function addPalm(position, scale = 1) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * scale, 0.11 * scale, 1.4 * scale, 10), new THREE.MeshStandardMaterial({ color: '#6a5136', roughness: 0.88 }));
      trunk.position.copy(position).add(new THREE.Vector3(0, 0.7 * scale, 0));
      trunk.castShadow = true;
      scene.add(trunk);
      for (let i = 0; i < 5; i += 1) {
        const leaf = new THREE.Mesh(new THREE.PlaneGeometry(0.95 * scale, 0.22 * scale), new THREE.MeshStandardMaterial({ color: '#476940', roughness: 0.84, side: THREE.DoubleSide }));
        leaf.position.copy(position).add(new THREE.Vector3(0, 1.35 * scale, 0));
        leaf.rotation.x = -Math.PI / 2.8;
        leaf.rotation.z = (Math.PI * 2 * i) / 5;
        scene.add(leaf);
      }
    }

    function addHuman(position, scale = 1) {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09 * scale, 0.8 * scale, 4, 8), new THREE.MeshStandardMaterial({ color: '#2e3540', roughness: 0.7 }));
      body.position.copy(position).add(new THREE.Vector3(0, 0.9 * scale, 0));
      body.castShadow = true;
      scene.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.12 * scale, 12, 12), new THREE.MeshStandardMaterial({ color: '#b99275', roughness: 0.62 }));
      head.position.copy(position).add(new THREE.Vector3(0, 1.48 * scale, 0));
      head.castShadow = true;
      scene.add(head);
    }

    function addContext(box) {
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const span = Math.max(size.x, size.z, 12);
      if (config.modelScope === 'district') {
        addPalm(new THREE.Vector3(center.x - span * 0.46, box.min.y, center.z + span * 0.22), span / 18);
        addPalm(new THREE.Vector3(center.x + span * 0.42, box.min.y, center.z - span * 0.28), span / 19);
      } else {
        addPalm(new THREE.Vector3(center.x - span * 0.34, box.min.y, center.z + span * 0.12), span / 20);
      }
      addPlanter(new THREE.Vector3(center.x - span * 0.18, box.min.y + 0.12, center.z - span * 0.24), span / 18);
      addPlanter(new THREE.Vector3(center.x + span * 0.18, box.min.y + 0.12, center.z - span * 0.24), span / 18);
      addHuman(new THREE.Vector3(center.x - span * 0.08, box.min.y, center.z - span * 0.34), 1);
      addHuman(new THREE.Vector3(center.x + span * 0.08, box.min.y, center.z - span * 0.31), 1);
    }

    function addLights(box) {
      const preset = config.lightingPresets[view.preset] || config.lightingPresets.daylight;
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const span = Math.max(size.x, size.z, size.y, 12);

      scene.add(new THREE.AmbientLight(view.preset === 'night' ? '#41566f' : '#d4e0ef', view.preset === 'night' ? 0.34 : 0.58));
      const hemi = new THREE.HemisphereLight(view.preset === 'night' ? '#819bc1' : '#f6f2ea', '#223140', view.preset === 'night' ? 0.5 : 0.92);
      scene.add(hemi);

      const sun = new THREE.DirectionalLight(view.preset === 'night' ? '#6c7f96' : view.preset === 'golden_hour' ? '#ffd0a0' : '#fff0d8', view.preset === 'night' ? 0.28 : 1.75);
      sun.position.set(center.x + span * 0.58, center.y + span * 1.08, center.z + span * 0.34);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 0.1;
      sun.shadow.camera.far = span * 6;
      sun.shadow.camera.left = -span * 1.6;
      sun.shadow.camera.right = span * 1.6;
      sun.shadow.camera.top = span * 1.6;
      sun.shadow.camera.bottom = -span * 1.6;
      scene.add(sun);

      const fill = new THREE.SpotLight(view.preset === 'night' ? '#7fa6d4' : '#fff1df', view.preset === 'night' ? 1.8 : 3.6, span * 4, Math.PI / 5, 0.42, 1.2);
      fill.position.set(center.x - span * 0.74, center.y + span * 0.5, center.z - span * 0.52);
      fill.target.position.set(center.x, center.y + size.y * 0.24, center.z);
      fill.castShadow = false;
      scene.add(fill);
      scene.add(fill.target);

      if (view.preset === 'night') {
        for (const offset of [-0.34, 0, 0.34]) {
          const point = new THREE.PointLight('#ffcf9d', 12, span * 2.4, 2);
          point.position.set(center.x + span * offset, box.min.y + size.y * 0.46, center.z - span * 0.36);
          scene.add(point);
        }
      }
    }

    function frameCamera(box) {
      const preset = CAMERA_PRESETS[view.cameraType] || CAMERA_PRESETS.corner;
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      const span = Math.max(size.x, size.z, size.y, 8);
      const distance = span * preset.distance;
      const yaw = THREE.MathUtils.degToRad(preset.yaw);
      const pitch = THREE.MathUtils.degToRad(preset.pitch);
      controls.target.set(center.x, center.y + size.y * preset.targetHeight, center.z);
      camera.position.set(
        center.x + Math.sin(yaw) * Math.cos(pitch) * distance,
        center.y + Math.sin(pitch) * distance + size.y * 0.16,
        center.z + Math.cos(yaw) * Math.cos(pitch) * distance
      );
      camera.near = Math.max(span / 500, 0.1);
      camera.far = span * 30;
      camera.fov = view.cameraType === 'bird' || view.cameraType === 'aerial_alt' ? 36 : 42;
      camera.updateProjectionMatrix();
      controls.update();
    }

      const loader = new GLTFLoader();
      statusEl.textContent = 'loading model';

      loader.load(config.glbFile, gltf => {
        const root = gltf.scene;
        scene.add(root);
        styleModel(root);
        const box = new THREE.Box3().setFromObject(root);
        addGround(box);
        addContext(box);
        addLights(box);
        frameCamera(box);

        let frames = 0;
        const tick = () => {
          frames += 1;
          controls.update();
          renderer.render(scene, camera);
          if (frames < 24) {
            requestAnimationFrame(tick);
            return;
          }
          statusEl.textContent = 'ready';
          document.body.dataset.renderReady = 'true';
        };
        tick();
      }, undefined, error => {
        console.error(error);
        statusEl.textContent = 'error';
        document.body.dataset.renderReady = 'error';
      });
    } catch (error) {
      console.error(error);
      statusEl.textContent = 'module error';
      document.body.dataset.renderReady = 'error';
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(renderHtmlPath, html);

  return {
    browserPath,
    renderHtmlPath,
    preferredModel,
    viewDefs,
    baseUrl,
    jobId,
  };
}

async function tryRenderStrategicViewsWithThreeJs(jobDir, scene, context, modelEntries = []) {
  const renderJob = buildThreeJsStrategicViews(jobDir, scene, context, modelEntries);
  if (!renderJob) return null;

  try {
    for (const view of renderJob.viewDefs) {
      const renderUrl = `${renderJob.baseUrl}/outputs/${renderJob.jobId}/${path.basename(renderJob.renderHtmlPath)}?view=${encodeURIComponent(view.id)}`;
      const captureAttempts = [
        ['--headless=new'],
        ['--headless'],
      ];
      let captured = false;

      for (const headlessArgs of captureAttempts) {
        try {
          await execFileAsync(renderJob.browserPath, [
            ...headlessArgs,
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio',
            '--run-all-compositor-stages-before-draw',
            '--virtual-time-budget=12000',
            `--window-size=${view.width},${view.height}`,
            `--screenshot=${view.pngPath}`,
            renderUrl,
          ], {
            cwd: jobDir,
            timeout: 90 * 1000,
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
          });
          captured = fs.existsSync(view.pngPath);
          if (captured) break;
        } catch (error) {
          captured = false;
        }
      }

      if (!captured || !fs.existsSync(view.pngPath)) {
        throw new Error(`Browser capture did not create ${path.basename(view.pngPath)}`);
      }

      const enhancement = await enhanceRenderedImage(
        view.pngPath,
        view.jpgPath,
        view.preset,
        context.modeling.enablePostEnhancement
      );

      view.renderMode = 'threejs-headless-glb';
      view.sourceModel = path.basename(renderJob.preferredModel.glbPath);
      view.renderPreset = view.preset;
      view.svgPath = '';
      view.enhanced = enhancement.enhanced;
    }

    return renderJob.viewDefs;
  } catch (error) {
    return null;
  }
}

function inferAspectRatio(view) {
  const ratio = (view.width || 1) / Math.max(view.height || 1, 1);
  if (ratio > 1.35) return '16:9';
  if (ratio > 1.15) return '4:3';
  if (ratio < 0.85) return '3:4';
  return '1:1';
}

async function renderNanoBananaImage(prompt, referencePaths, pngPath, jpgPath, view) {
  if (!replicate) {
    throw new Error('Replicate provider is not configured for Nano Banana image generation.');
  }

  const input = {
    prompt,
    image_input: referencePaths.map(fileToDataUri),
    output_format: 'png',
    aspect_ratio: inferAspectRatio(view),
    resolution: '1K',
    number_of_images: 1,
  };

  const output = await replicate.run(SERVICE_05_IMAGE_MODEL, { input });
  const outputUrls = [...new Set(collectHttpUrls(output))];
  const imageUrl = outputUrls.find(url => /\.(png|jpe?g|webp)(\?|$)/i.test(url)) || outputUrls[0];
  if (!imageUrl) {
    throw new Error(`Replicate Nano Banana output was empty for ${view.id}.`);
  }

  const tempPath = `${pngPath}.download`;
  await downloadFile(imageUrl, tempPath);
  const pngBuffer = await sharp(tempPath)
    .resize(view.width, view.height, { fit: 'cover', position: 'attention' })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  fs.unlinkSync(tempPath);
  fs.writeFileSync(pngPath, pngBuffer);

  await sharp(pngBuffer)
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
    .toFile(jpgPath);
}

async function tryGenerateStrategicViewsWithNanoBanana(jobDir, context, rawViews = [], modelEntries = []) {
  if (!replicate) return null;
  const plan = buildStrategicRenderPlan(jobDir, context, modelEntries);
  const baseViews = rawViews?.length ? rawViews : plan?.viewDefs || [];
  if (!baseViews.length) return null;

  const outputs = [];
  for (const view of baseViews) {
    const rawGuidePath = fs.existsSync(view.pngPath) ? view.pngPath : '';
    const referencePaths = collectNanoBananaReferenceImages(context, view, rawGuidePath);
    const prompt = buildNanoBananaPrompt(context, view, referencePaths);

    try {
      await renderNanoBananaImage(prompt, referencePaths, view.pngPath, view.jpgPath, view);
      outputs.push({
        ...view,
        svgPath: '',
        renderMode: 'nano-banana-replicate',
        renderPreset: view.preset || 'daylight',
        enhanced: true,
        sourceModel: path.basename((plan?.preferredModel || modelEntries[0] || {}).glbPath || ''),
        imageProvider: 'replicate',
        imageModel: SERVICE_05_IMAGE_MODEL,
      });
    } catch (error) {
      if (rawGuidePath && fs.existsSync(rawGuidePath) && fs.existsSync(view.jpgPath)) {
        outputs.push({
          ...view,
          svgPath: '',
          renderMode: 'threejs-raw-backup',
          renderPreset: view.preset || 'daylight',
          enhanced: Boolean(view.enhanced),
          sourceModel: path.basename((plan?.preferredModel || modelEntries[0] || {}).glbPath || ''),
          backupReason: error.message,
        });
        continue;
      }
      return null;
    }
  }

  return outputs;
}

function renderSceneSvg(meshInput, options) {
  const meshes = (Array.isArray(meshInput) ? meshInput : [meshInput]).filter(Boolean);
  const width = options.width || 1600;
  const height = options.height || 900;
  const background = options.background || '#0b1521';
  const stroke = options.stroke || 'rgba(255,255,255,0.16)';
  const bounds = computeBoundsForMeshes(meshes);
  const center = [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ];
  const scale = Math.min(width / Math.max(bounds.width * 1.16, 1), height / Math.max((bounds.depth + bounds.height) * 1.08, 1));
  const light = [0.45, -0.24, 0.86];
  const polygons = [];

  for (const mesh of meshes) {
    const baseColor = hexToRgb01(mesh.colorHex || '#b99d7a');
    for (const face of mesh.faces) {
      const verts = face.map(index => mesh.vertices[index]);
      const world = verts.map(([x, y, z]) => [x - center[0], y - center[1], z - center[2]]);
      const rotated = world.map(vertex => rotatePoint(vertex, options.yaw || -35, options.pitch || 28));
      const normal = computeFaceNormal(rotated[0], rotated[1], rotated[2]);
      if (normal[2] < -0.2) continue;

      const shade = clamp(normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2], 0.16, 1);
      const depth = rotated.reduce((sum, point) => sum + point[1], 0) / rotated.length;
      const altitude = rotated.reduce((sum, point) => sum + point[2], 0) / rotated.length;
      const exposure = 0.54 + shade * 0.72 + clamp(altitude / Math.max(bounds.height, 1), -0.05, 0.14);
      const fill = `rgb(${Math.round(clamp(baseColor.r * exposure, 0, 1) * 255)},${Math.round(clamp(baseColor.g * exposure, 0, 1) * 255)},${Math.round(clamp(baseColor.b * exposure, 0, 1) * 255)})`;
      const edge = `rgba(16,26,38,${clamp(0.16 + shade * 0.22, 0.16, 0.34).toFixed(2)})`;
      const highlight = `rgba(255,244,219,${clamp(0.04 + shade * 0.12, 0.05, 0.18).toFixed(2)})`;
      const points = rotated.map(([x, y, z]) => ({
        x: width / 2 + x * scale,
        y: height * 0.68 - z * scale - y * scale * 0.12,
      }));

      polygons.push({
        depth,
        fill,
        edge,
        highlight,
        points,
      });
    }
  }

  polygons.sort((a, b) => a.depth - b.depth);
  const footprintWidth = Math.max(bounds.width * scale * 0.88, width * 0.22);
  const footprintDepth = Math.max(bounds.depth * scale * 0.2, height * 0.05);
  const polygonMarkup = polygons.map(poly => {
    const points = poly.points.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    return `<polygon points="${points}" fill="${poly.fill}" stroke="${poly.edge || stroke}" stroke-width="0.95" />
  <polyline points="${points}" fill="none" stroke="${poly.highlight}" stroke-width="0.45" />`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${background}" />
      <stop offset="100%" stop-color="#14263c" />
    </linearGradient>
    <linearGradient id="ground" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.08)" />
      <stop offset="100%" stop-color="rgba(255,255,255,0.02)" />
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="26" flood-color="rgba(3,8,16,0.48)" />
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <rect x="${width * 0.03}" y="${height * 0.07}" width="${width * 0.94}" height="${height * 0.86}" rx="24" fill="rgba(255,255,255,0.02)" stroke="rgba(223,184,103,0.12)" />
  <line x1="${width * 0.05}" y1="${height * 0.68}" x2="${width * 0.95}" y2="${height * 0.68}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
  <ellipse cx="${width / 2}" cy="${height * 0.72}" rx="${footprintWidth}" ry="${footprintDepth}" fill="rgba(5,10,18,0.34)" />
  <rect x="${width * 0.17}" y="${height * 0.63}" width="${width * 0.66}" height="${height * 0.13}" fill="url(#ground)" rx="999" />
  <g filter="url(#shadow)">
    ${polygonMarkup}
  </g>
  <text x="${width * 0.06}" y="${height * 0.11}" font-family="Arial" font-size="28" fill="#dfb867" font-weight="700">${options.title || (meshes[0]?.name || 'Scene')}</text>
  <text x="${width * 0.06}" y="${height * 0.15}" font-family="Arial" font-size="14" fill="#d5dde8">${options.subtitle || 'Service 05 strategic render view'}</text>
</svg>`;
}

async function buildStrategicViews(jobDir, scene, context, modelEntries = []) {
  const blenderViews = await tryRenderStrategicViewsWithBlender(jobDir, scene, context, modelEntries);
  if (blenderViews?.length) {
    return blenderViews;
  }

  throw new Error('Service 05 presentation rendering failed: Blender official rendering is required and no official Blender renders were produced.');
}

async function buildWordGuide(context, sceneSummary, scene, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const paragraphs = [
    new Paragraph({
      text: `${SERVICE_05_NAME} - Model Delivery Guide`,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [new TextRun({ text: compactText(SERVICE_05_DEFINITION, 420) })],
    }),
    new Paragraph({ text: 'Project Summary', heading: HeadingLevel.HEADING_1 }),
    new Paragraph(`Project: ${context.project.title}`),
    new Paragraph(`Scope: ${context.modeling.modelScope}`),
    new Paragraph(`Intent: ${context.modeling.intentProfile.label}`),
    new Paragraph(`Detail level: ${context.modeling.detailProfile.label}`),
    new Paragraph(`Buildings generated: ${scene.buildings.length}`),
    new Paragraph(`Master-plan included: ${context.modeling.includeMasterPlan ? 'Yes' : 'No'}`),
    new Paragraph({ text: 'Workflow Notes', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('1. Review the GLB files for web and presentation use.'),
    new Paragraph('2. Use FBX/OBJ for professional editing workflows.'),
    new Paragraph(`3. Use STL exports for fabrication workflows. Minimum structural thickness target: ${context.modeling.minimumThicknessMm.toFixed(1)} mm.`),
    new Paragraph('4. Open the generated HTML viewer for browser-based interactive exploration.'),
    new Paragraph({ text: 'Building Inventory', heading: HeadingLevel.HEADING_1 }),
  ];

  scene.buildings.forEach((building, index) => {
    paragraphs.push(new Paragraph(`${index + 1}. ${building.name} - ${building.buildingType} - ${building.style}`));
  });

  paragraphs.push(new Paragraph({ text: 'Technical Notes', heading: HeadingLevel.HEADING_1 }));
  paragraphs.push(new Paragraph(`Scene footprint: ${sceneSummary.sceneFootprint}.`));
  paragraphs.push(new Paragraph(`Scene height: ${sceneSummary.sceneHeight}.`));
  paragraphs.push(new Paragraph(`Printable width target: ${context.modeling.intentProfile.targetSceneWidthMm} mm.`));
  paragraphs.push(new Paragraph(`Representative heritage emphasis: ${sceneSummary.heritageSummary}.`));

  const doc = new Document({
    sections: [{
      properties: {},
      children: paragraphs,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

async function buildPdfCatalog(context, views, sceneSummary, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    setPdfFont(doc, true).fontSize(22).text(context.project.title, { align: 'center' });
    doc.moveDown(0.4);
    setPdfFont(doc).fontSize(11).fillColor('#475569').text(SERVICE_05_NAME, { align: 'center' });
    doc.moveDown(1.2);

    setPdfFont(doc, true).fontSize(15).fillColor('#0f172a').text('Modeling Summary');
    setPdfFont(doc).fontSize(11).fillColor('#334155');
    doc.text(`Scope: ${context.modeling.modelScope}`);
    doc.text(`Intent: ${context.modeling.intentProfile.label}`);
    doc.text(`Detail level: ${context.modeling.detailProfile.label}`);
    doc.text(`Buildings: ${sceneSummary.buildingCount}`);
    doc.text(`Heritage emphasis: ${sceneSummary.heritageSummary}`);
    doc.moveDown(0.8);

    for (const view of views) {
      if (doc.y > 500) doc.addPage();
      setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(view.title);
      setPdfFont(doc).fontSize(10).fillColor('#475569').text(view.subtitle);
      doc.moveDown(0.35);
      if (fs.existsSync(view.jpgPath)) {
        doc.image(view.jpgPath, { fit: [520, 250], align: 'center', valign: 'center' });
      }
      doc.moveDown(0.9);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildExcelManifest(context, scene, outputFiles, outPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_05_NAME;
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ header: 'Field', width: 28 }, { header: 'Value', width: 56 }];
  summary.addRows([
    ['Project', context.project.title],
    ['Scope', context.modeling.modelScope],
    ['Intent', context.modeling.intentProfile.label],
    ['Detail level', context.modeling.detailProfile.label],
    ['Buildings', scene.buildings.length],
    ['Minimum thickness (mm)', context.modeling.minimumThicknessMm],
    ['Master-plan included', context.modeling.includeMasterPlan ? 'Yes' : 'No'],
  ]);

  const buildings = workbook.addWorksheet('Buildings');
  buildings.columns = [
    { header: 'Name', width: 28 },
    { header: 'Type', width: 24 },
    { header: 'Style', width: 22 },
    { header: 'Floors', width: 10 },
    { header: 'Area (sqm)', width: 14 },
    { header: 'Width', width: 12 },
    { header: 'Depth', width: 12 },
    { header: 'Height', width: 12 },
    { header: 'Source Job', width: 24 },
  ];
  scene.buildings.forEach(building => {
    buildings.addRow([
      building.name,
      building.buildingType,
      building.style,
      building.floors,
      building.area,
      Number(building.width.toFixed(2)),
      Number(building.depth.toFixed(2)),
      Number(building.height.toFixed(2)),
      building.sourceJobId || 'Manual / fallback',
    ]);
  });

  const filesSheet = workbook.addWorksheet('Files');
  filesSheet.columns = [
    { header: 'Label', width: 34 },
    { header: 'Extension', width: 12 },
    { header: 'URL', width: 56 },
  ];
  outputFiles.forEach(file => filesSheet.addRow([file.label, file.ext, file.url]));

  await workbook.xlsx.writeFile(outPath);
}

function buildViewerManifest(context, scene, modelEntries, views) {
  const seen = new Set();
  const models = [];
  for (const entry of modelEntries) {
    const key = `${entry.role}:${path.basename(entry.glbPath || '')}`;
    if (!entry.glbPath || seen.has(key)) continue;
    seen.add(key);
    models.push({
      name: entry.name,
      file: path.basename(entry.glbPath),
      role: entry.role,
    });
  }

  return {
    serviceName: SERVICE_05_NAME,
    generatedAt: new Date().toISOString(),
    projectTitle: context.project.title,
    scope: context.modeling.modelScope,
    intent: context.modeling.intentProfile.label,
    models,
    renderViews: views.map(view => ({
      id: view.id,
      title: view.title,
      image: path.basename(view.jpgPath),
    })),
  };
}

function buildViewerHtml(manifest, outPath) {
  const encodedManifest = JSON.stringify(manifest);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${manifest.projectTitle} - 3D Viewer</title>
  <script type="importmap">
    {
      "imports": {
        "three": "/vendor/three/build/three.module.js",
        "three/addons/": "/vendor/three/examples/jsm/"
      }
    }
  </script>
  <style>
    :root{color-scheme:dark;--bg:#0b1521;--panel:#122338;--line:#294663;--accent:#dfb867;--text:#e5edf7;--muted:#9db1c7}
    *{box-sizing:border-box}
    body{margin:0;font-family:Arial,sans-serif;background:radial-gradient(circle at top,#193149 0,#0b1521 58%);color:var(--text);min-height:100vh}
    .layout{display:grid;grid-template-columns:320px 1fr;min-height:100vh}
    .sidebar{padding:24px;border-right:1px solid rgba(255,255,255,.08);background:rgba(9,18,30,.72);backdrop-filter:blur(14px)}
    .viewer{position:relative}
    h1{font-size:22px;margin:0 0 8px}
    p{color:var(--muted);line-height:1.6}
    .panel{background:rgba(18,35,56,.8);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:16px;margin-top:16px}
    select,a{width:100%;display:block;margin-top:10px;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:#102033;color:var(--text);text-decoration:none}
    .chip{display:inline-block;border:1px solid rgba(223,184,103,.28);color:var(--accent);border-radius:999px;padding:5px 10px;font-size:12px;margin:0 8px 8px 0}
    canvas{display:block}
    .thumbs{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
    .thumbs img{width:100%;border-radius:12px;border:1px solid rgba(255,255,255,.08)}
    .viewer-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:28px;text-align:center;color:var(--muted)}
    .viewer-card{max-width:520px;border:1px solid rgba(255,255,255,.08);background:rgba(18,35,56,.82);border-radius:18px;padding:20px}
    .viewer-card strong{display:block;color:var(--text);font-size:18px;margin-bottom:10px}
    .viewer-card a{margin-top:14px}
    @media (max-width:900px){.layout{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid rgba(255,255,255,.08);}}
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1>${manifest.projectTitle}</h1>
      <p>Interactive browser viewer generated by Service 05. Use the dropdown below to switch between the individual building models and the master scene.</p>
      <div class="panel">
        <div class="chip">${manifest.intent}</div>
        <div class="chip">${manifest.scope}</div>
        <label for="modelSelect">Model</label>
        <select id="modelSelect"></select>
        <a id="downloadLink" href="#" download>Download current GLB</a>
        <a id="openLink" href="#" target="_blank" rel="noreferrer">Open current GLB in new tab</a>
      </div>
      <div class="panel">
        <strong>Rendered Views</strong>
        <div class="thumbs" id="thumbs"></div>
      </div>
    </aside>
    <main class="viewer" id="viewer">
      <div class="viewer-empty" id="viewerEmpty">
        <div class="viewer-card">
          <strong>Preparing 3D viewer</strong>
          <div id="viewerStatus">Loading viewer libraries and model...</div>
        </div>
      </div>
    </main>
  </div>
  <script type="module">
    const manifest = ${encodedManifest};
    const viewer = document.getElementById('viewer');
    const select = document.getElementById('modelSelect');
    const downloadLink = document.getElementById('downloadLink');
    const openLink = document.getElementById('openLink');
    const thumbs = document.getElementById('thumbs');
    const viewerEmpty = document.getElementById('viewerEmpty');
    const viewerStatus = document.getElementById('viewerStatus');

    function setViewerStatus(text, withLink) {
      viewerStatus.textContent = text;
      if (withLink && select.value) {
        viewerStatus.innerHTML = text + '<br><a href="' + select.value + '" target="_blank" rel="noreferrer">Open GLB directly</a>';
      }
    }

    function updateLinks(file) {
      if (!file) return;
      downloadLink.href = file;
      openLink.href = file;
      downloadLink.textContent = 'Download current GLB (' + file + ')';
      openLink.textContent = 'Open current GLB (' + file + ')';
    }

    manifest.models.forEach((model, index) => {
      const option = document.createElement('option');
      option.value = model.file;
      option.textContent = model.name + ' - ' + model.role;
      if (index === 0) option.selected = true;
      select.appendChild(option);
    });

    manifest.renderViews.forEach(viewData => {
      const img = document.createElement('img');
      img.src = viewData.image;
      img.alt = viewData.title;
      img.title = viewData.title;
      thumbs.appendChild(img);
    });

    if (!select.value) {
      setViewerStatus('No GLB model was listed in the viewer manifest.', false);
    } else {
      updateLinks(select.value);
    }

    async function bootViewer() {
      if (!select.value) return;

      try {
        const [THREE, controlsModule, loaderModule] = await Promise.all([
          import('three'),
          import('three/addons/controls/OrbitControls.js'),
          import('three/addons/loaders/GLTFLoader.js'),
        ]);

        const { OrbitControls } = controlsModule;
        const { GLTFLoader } = loaderModule;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#0b1521');

        const camera = new THREE.PerspectiveCamera(52, viewer.clientWidth / Math.max(viewer.clientHeight, 1), 0.1, 5000);
        camera.position.set(28, 20, 34);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(viewer.clientWidth || window.innerWidth, viewer.clientHeight || window.innerHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        viewer.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.target.set(0, 6, 0);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x1f2937, 1.35));
        const dirLight = new THREE.DirectionalLight(0xfff3d6, 1.5);
        dirLight.position.set(26, 34, 18);
        scene.add(dirLight);
        scene.add(new THREE.GridHelper(220, 24, 0x375472, 0x20354c));

        const loader = new GLTFLoader();
        let current = null;

        function frameObject(object) {
          const box = new THREE.Box3().setFromObject(object);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const maxSize = Math.max(size.x, size.y, size.z) || 1;
          const distance = maxSize * 1.8;
          camera.near = Math.max(maxSize / 500, 0.1);
          camera.far = Math.max(maxSize * 20, 1000);
          camera.updateProjectionMatrix();
          camera.position.set(center.x + distance * 0.95, center.y + distance * 0.62, center.z + distance * 1.08);
          controls.target.copy(center);
          controls.update();
        }

        function loadModel(file) {
          if (!file) return;
          updateLinks(file);
          setViewerStatus('Loading model...', false);
          loader.load(file, gltf => {
            if (current) scene.remove(current);
            current = gltf.scene;
            scene.add(current);
            frameObject(current);
            viewerEmpty.style.display = 'none';
          }, undefined, error => {
            setViewerStatus('The GLB file exists, but the browser viewer could not parse it here.', true);
            console.error('GLB load failed', error);
          });
        }

        select.addEventListener('change', () => loadModel(select.value));
        loadModel(select.value);

        function resize() {
          const width = viewer.clientWidth || window.innerWidth;
          const height = viewer.clientHeight || window.innerHeight;
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
          renderer.setSize(width, height);
        }

        window.addEventListener('resize', resize);
        resize();

        function animate() {
          controls.update();
          renderer.render(scene, camera);
          requestAnimationFrame(animate);
        }

        animate();
      } catch (error) {
        console.error('Viewer bootstrap failed', error);
        setViewerStatus('The 3D viewer libraries could not be loaded in this browser session.', true);
      }
    }

    bootViewer();
  </script>
</body>
</html>`;

  fs.writeFileSync(outPath, html);
}

function buildSceneSummary(context, scene) {
  const elements = new Set();
  scene.buildings.forEach(building => {
    (building.styleElements || []).forEach(element => elements.add(element));
  });
  const inputInfluence = buildContextInfluenceSummary(context);

  return {
    buildingCount: scene.buildings.length,
    generationMode: context.modeling.generationMode,
    sceneFootprint: `${scene.bounds.width.toFixed(1)} x ${scene.bounds.depth.toFixed(1)} units`,
    sceneHeight: `${scene.bounds.height.toFixed(1)} units`,
    heritageSummary: elements.size
      ? Array.from(elements).slice(0, 6).join(', ')
      : 'windows, doors, arches, facade bands, roof parapets',
    inputInfluence,
  };
}

async function exportSceneFiles(jobId, jobDir, context, scene, aiGeneration = { assets: [] }) {
  const outputFiles = [];
  const modelEntries = [];
  const exportFormats = new Set((context.modeling.exportFormats || []).map(item => String(item).toLowerCase()));
  if (context.modeling.htmlViewer) exportFormats.add('glb');
  const aiBuildingIds = new Set((aiGeneration.assets || []).map(asset => asset.buildingId));

  for (const asset of aiGeneration.assets || []) {
    for (const file of asset.files || []) {
      if (!exportFormats.has(file.ext) && !(file.ext === 'glb' && context.modeling.htmlViewer)) continue;
      outputFiles.push({ label: file.label, url: file.url, ext: file.ext });
      if (file.ext === 'glb') {
        modelEntries.push({ name: asset.buildingName, role: 'ai-individual-building', glbPath: file.path });
      }
    }
  }

  const exportModelBundle = (name, role, mesh, colorHex) => {
    const base = slugify(name, role);
    const objPath = path.join(jobDir, `${base}.obj`);
    const stlPath = path.join(jobDir, `${base}.stl`);
    const glbPath = path.join(jobDir, `${base}.glb`);
    const fbxPath = path.join(jobDir, `${base}.fbx`);

    if (exportFormats.has('obj')) {
      writeObj(mesh, objPath);
      outputFiles.push({ label: `${name} (OBJ)`, url: relOutputUrl(jobId, objPath), ext: 'obj' });
    }
    if (exportFormats.has('stl')) {
      writeStl(mesh, stlPath);
      outputFiles.push({ label: `${name} (STL)`, url: relOutputUrl(jobId, stlPath), ext: 'stl' });
    }
    if (exportFormats.has('glb')) {
      buildGlb(mesh, glbPath, colorHex);
      outputFiles.push({ label: `${name} (GLB)`, url: relOutputUrl(jobId, glbPath), ext: 'glb' });
      modelEntries.push({ name, role, glbPath });
    }
    if (exportFormats.has('fbx')) {
      buildAsciiFbx(mesh, fbxPath, colorHex);
      outputFiles.push({ label: `${name} (FBX)`, url: relOutputUrl(jobId, fbxPath), ext: 'fbx' });
    }
  };

  if (context.modeling.includeSeparateBuildings) {
    scene.buildings.forEach((building, index) => {
      if (aiBuildingIds.has(building.id)) return;
      const mesh = context.modeling.intentProfile.printable
        ? scene.printableBuildings[index].printableMesh
        : building.mergedMesh;
      exportModelBundle(building.name, 'individual-building', mesh, building.palette.base);
    });
  }

  if (context.modeling.includeMasterPlan || context.modeling.modelScope === 'district') {
    exportModelBundle(
      context.modeling.modelScope === 'district' ? 'Master Plan Model' : 'Unified Building Scene',
      'master-scene',
      context.modeling.intentProfile.printable ? scene.printableMasterScene : scene.masterScene,
      '#b99d7a'
    );
  }

  return { outputFiles, modelEntries };
}

function buildMetadata(context, linkedJobs, sceneSummary, outputFiles, docs, views, providerSummary = {}) {
  const inputInfluence = buildContextInfluenceSummary(context);
  return {
    service: 5,
    serviceName: SERVICE_05_NAME,
    serviceDefinition: SERVICE_05_DEFINITION,
    project: context.project,
    modeling: {
      detailLevel: context.modeling.detailLevel,
      detailLabel: context.modeling.detailProfile.label,
      modelIntent: context.modeling.modelIntent,
      intentLabel: context.modeling.intentProfile.label,
      modelScope: context.modeling.modelScope,
      minimumThicknessMm: context.modeling.minimumThicknessMm,
      exportFormats: context.modeling.exportFormats,
      renderEngine: context.modeling.renderEngine,
      renderStyle: context.modeling.renderStyle,
      renderQuality: context.modeling.renderQuality,
      postEnhancement: context.modeling.enablePostEnhancement,
      generationMode: context.modeling.generationMode,
    },
    linkedJobs: linkedJobs.map(job => ({
      jobId: job.jobId,
      service: job.service,
      serviceName: job.serviceName,
    })),
    inputInfluence,
    summary: sceneSummary,
    outputFiles,
    documentation: docs,
    views: views.map(view => ({
      id: view.id,
      title: view.title,
      renderMode: view.renderMode || 'render-pipeline-unavailable',
      renderPreset: view.renderPreset || 'daylight',
      enhanced: Boolean(view.enhanced),
      png: path.basename(view.pngPath),
      jpg: path.basename(view.jpgPath),
    })),
    provider: providerSummary.provider || 'local-procedural',
    providerModel: providerSummary.model || 'heritage-scene-generator-v1',
    presentationImageProvider: providerSummary.presentationImageProvider || 'raw-backup',
    presentationImageModel: providerSummary.presentationImageModel || '',
    aiGeneratedBuildings: providerSummary.aiGeneratedBuildings || [],
    generatedAt: new Date().toISOString(),
    warnings: [
      ...(providerSummary.warnings || []),
      'This Service 05 implementation generates procedural 3D geometry from structured project inputs and linked Service 02/03 metadata.',
      'Professional mesh refinement, photogrammetry, and scan-grade reconstruction are outside the scope of the current local implementation.',
    ],
  };
}

function buildResponsePreview(context, sceneSummary) {
  return {
    title: context.project.title,
    scope: context.modeling.modelScope,
    generationMode: context.modeling.generationMode,
    intent: context.modeling.intentProfile.label,
    buildingCount: sceneSummary.buildingCount,
    sceneFootprint: sceneSummary.sceneFootprint,
    heritageSummary: sceneSummary.heritageSummary,
  };
}

router.get('/jobs', (req, res) => {
  try {
    const jobs = discoverPreviousJobs();
    res.json({ success: true, jobs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', (req, res, next) => {
  upload.any()(req, res, error => {
    if (error) return res.status(400).json({ error: error.message });
    next();
  });
}, async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const uploadedFilesSummary = summarizeUploadedFiles(uploadedFiles);
  const serviceJobIds = [
    ...parseCsvList(req.body.service2JobId),
    ...parseCsvList(req.body.service3JobId),
  ];

  let jobRecord = null;
  if (Job) {
    try {
      jobRecord = await Job.create({
        jobId,
        service: 5,
        status: 'processing',
        inputFiles: uploadedFiles.map(file => ({
          originalName: file.originalname,
          storedPath: file.path,
          sizeBytes: file.size,
        })),
        metadata: { request: req.body || {} },
      });
    } catch (error) {
      // Optional persistence only.
    }
  }

  try {
    const linkedJobs = [];
    for (const linkedJobId of serviceJobIds) {
      linkedJobs.push(loadJobContext(linkedJobId));
    }

    for (const parsedMeta of uploadedFilesSummary.parsedMetadata) {
      const tempJobDir = path.join(UPLOADS_DIR, '_virtual');
      if (parsedMeta.service === 2) linkedJobs.push(summarizeService2(parsedMeta, tempJobDir));
      if (parsedMeta.service === 3) linkedJobs.push(summarizeService3(parsedMeta, tempJobDir));
    }

    const dedupedJobs = dedupeByJobId(linkedJobs);
    const context = await buildModelContext(req.body || {}, dedupedJobs, uploadedFilesSummary);
    // Store user's 3D prompt override in context so buildReplicate3DPrompt can use it
    context.promptOverride = normalizeText(req.body?.promptOverride || '');
    context.runtime = {
      appBaseUrl: resolveAppBaseUrl(req),
    };
    const scene = buildSceneGeometry(context);
    const sceneSummary = buildSceneSummary(context, scene);
    const aiGeneration = await buildReplicateAssets(jobId, jobDir, context);
    const modelExports = await exportSceneFiles(jobId, jobDir, context, scene, aiGeneration);
    const views = await buildStrategicViews(jobDir, scene, context, modelExports.modelEntries);

    const viewerManifest = buildViewerManifest(context, scene, modelExports.modelEntries, views);
    const viewerManifestPath = path.join(jobDir, 'viewer_manifest.json');
    const viewerHtmlPath = path.join(jobDir, 'interactive_viewer.html');
    fs.writeFileSync(viewerManifestPath, JSON.stringify(viewerManifest, null, 2));
    buildViewerHtml(viewerManifest, viewerHtmlPath);

    const wordPath = path.join(jobDir, 'model_guide.docx');
    const pdfPath = path.join(jobDir, 'model_catalog.pdf');
    const excelPath = path.join(jobDir, 'model_manifest.xlsx');
    await buildWordGuide(context, sceneSummary, scene, wordPath);
    await buildPdfCatalog(context, views, sceneSummary, pdfPath);
    await buildExcelManifest(context, scene, [
      ...modelExports.outputFiles,
      { label: 'Interactive Viewer (HTML)', url: relOutputUrl(jobId, viewerHtmlPath), ext: 'html' },
      { label: 'Viewer Manifest (JSON)', url: relOutputUrl(jobId, viewerManifestPath), ext: 'json' },
    ], excelPath);

    const outputFiles = [
      ...modelExports.outputFiles,
      ...views.flatMap(view => {
        const files = [
          { label: `${view.title} (PNG)`, url: relOutputUrl(jobId, view.pngPath), ext: 'png' },
          { label: `${view.title} (JPG)`, url: relOutputUrl(jobId, view.jpgPath), ext: 'jpg' },
        ];
        if (view.svgPath) {
          files.push({ label: `${view.title} (SVG)`, url: relOutputUrl(jobId, view.svgPath), ext: 'svg' });
        }
        return files;
      }),
      { label: 'Interactive Viewer (HTML)', url: relOutputUrl(jobId, viewerHtmlPath), ext: 'html' },
      { label: 'Viewer Manifest (JSON)', url: relOutputUrl(jobId, viewerManifestPath), ext: 'json' },
      { label: 'Model Guide (Word)', url: relOutputUrl(jobId, wordPath), ext: 'docx' },
      { label: 'Rendered Catalog (PDF)', url: relOutputUrl(jobId, pdfPath), ext: 'pdf' },
      { label: 'Model File Manifest (Excel)', url: relOutputUrl(jobId, excelPath), ext: 'xlsx' },
    ];

    const docs = {
      word: path.basename(wordPath),
      pdf: path.basename(pdfPath),
      excel: path.basename(excelPath),
      htmlViewer: path.basename(viewerHtmlPath),
    };
    const providerSummary = {
      provider: aiGeneration.assets.length ? 'replicate/tencent-hunyuan + local-procedural' : 'local-procedural',
      model: aiGeneration.assets.length ? `${REPLICATE_3D_PRIMARY_MODEL} + ${REPLICATE_3D_FALLBACK_MODEL} + heritage-scene-generator-v1` : 'heritage-scene-generator-v1',
      presentationImageProvider: views.some(view => view.renderMode === 'blender-official')
        ? 'blender-official'
        : views.some(view => view.renderMode === 'threejs-raw-backup')
          ? 'threejs-raw-backup'
          : '',
      presentationImageModel: views.some(view => view.renderMode === 'blender-official') ? 'cycles-official-render' : '',
      aiGeneratedBuildings: aiGeneration.assets.map(asset => ({
        buildingId: asset.buildingId,
        buildingName: asset.buildingName,
        provider: asset.provider,
        model: asset.model,
        attemptLabel: asset.attemptLabel,
      })),
      warnings: aiGeneration.warnings,
    };
    const metadata = buildMetadata(context, dedupedJobs, sceneSummary, outputFiles, docs, views, providerSummary);
    metadata.jobId = jobId;

    const metaPath = path.join(jobDir, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    outputFiles.push({ label: 'Process Metadata (JSON)', url: relOutputUrl(jobId, metaPath), ext: 'json' });

    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'done';
        jobRecord.outputFiles = outputFiles;
        jobRecord.completedAt = new Date();
        jobRecord.metadata = metadata;
        await jobRecord.save();
      } catch (error) {
        // Ignore persistence failures.
      }
    }

    res.json({
      success: true,
      jobId,
      serviceName: SERVICE_05_NAME,
      provider: providerSummary.provider,
      model: providerSummary.model,
      preview: buildResponsePreview(context, sceneSummary),
      sceneSummary,
      outputFiles,
      warnings: aiGeneration.warnings,
      viewer: {
        htmlUrl: relOutputUrl(jobId, viewerHtmlPath),
        manifestUrl: relOutputUrl(jobId, viewerManifestPath),
      },
      buildings: scene.buildings.map(building => ({
        name: building.name,
        type: building.buildingType,
        style: building.style,
        floors: building.floors,
        area: building.area,
      })),
    });
  } catch (error) {
    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'failed';
        jobRecord.error = error.message;
        await jobRecord.save();
      } catch (saveError) {
        // Ignore non-fatal persistence issues.
      }
    }

    res.status(500).json({ error: error.message || 'Service 05 modeling failed.' });
  }
});

router.get('/job/:jobId', async (req, res) => {
  const jobDir = path.join(OUTPUTS_DIR, req.params.jobId);
  const metaPath = path.join(jobDir, 'metadata.json');

  if (fs.existsSync(metaPath)) {
    return res.json({ metadata: safeReadJson(metaPath, {}) });
  }

  if (Job) {
    try {
      const job = await Job.findOne({ jobId: req.params.jobId, service: 5 });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      return res.json(job);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(404).json({ error: 'Job not found' });
});

module.exports = router;
