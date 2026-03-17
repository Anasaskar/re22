'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

let Document;
let Packer;
let Paragraph;
let TextRun;
let HeadingLevel;
let AlignmentType;
let ImageRun;
try {
  ({ Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = require('docx'));
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

const SERVICE_06_NAME = 'Documentation & Media Outputs';
const SERVICE_06_DEFINITION = 'Aggregate, classify, package, and present outputs from Services 01 to 05 into professional dossiers, building documents, media kits, digital portfolio deliverables, and delivery-ready archive bundles.';

const SERVICE_NAMES = {
  1: 'Visual Intelligence Restoration',
  2: 'Architectural Rehabilitation Visualization',
  3: 'Geospatial Analysis & Urban Fabric Restoration',
  4: 'Automated Academic Reporting',
  5: 'Comprehensive 3D Modeling',
  6: SERVICE_06_NAME,
};

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
const PDF_FONT_REGULAR = 'C:\\Windows\\Fonts\\arial.ttf';
const PDF_FONT_BOLD = 'C:\\Windows\\Fonts\\arialbd.ttf';
const PDF_FONT_SEGOE = 'C:\\Windows\\Fonts\\segoeui.ttf';
const PDF_FONT_SEGOE_BOLD = 'C:\\Windows\\Fonts\\segoeuib.ttf';
const PDF_FONT_TAHOMA = 'C:\\Windows\\Fonts\\tahoma.ttf';
const PDF_FONT_TAHOMA_BOLD = 'C:\\Windows\\Fonts\\tahomabd.ttf';

[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.svg',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx',
  '.json', '.geojson', '.kml', '.kmz', '.html', '.htm', '.txt', '.md', '.ai',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.dxf', '.zip',
]);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const WEB_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.stl']);
const MAP_EXTENSIONS = new Set(['.geojson', '.kml', '.kmz']);
const DRAWING_EXTENSIONS = new Set(['.dxf', '.svg', '.ai']);
const REPORT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.txt', '.md']);
const PRESENTATION_EXTENSIONS = new Set(['.ppt', '.pptx']);
const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx', '.csv']);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `s6_${Date.now()}_${uuidv4().slice(0, 8)}${path.extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 120 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext || ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

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

function normalizeMultiline(value, fallback = 'Not provided.') {
  const text = normalizeText(value);
  return text || fallback;
}

function parseCsvList(value) {
  return normalizeText(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || fallback;
}

function compactText(value, maxLength = 240) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function relOutputUrl(jobId, filePath) {
  const jobRoot = path.join(OUTPUTS_DIR, jobId);
  return `/outputs/${jobId}/${toWebPath(path.relative(jobRoot, filePath))}`;
}

function publicPathFromUrl(urlPath) {
  return path.join(__dirname, '../../public', String(urlPath || '').replace(/^\/+/, ''));
}

function resolvePdfFontPath(typography = 'Arial', bold = false) {
  const preferred = normalizeText(typography, 'Arial').toLowerCase();
  const candidates = [];

  if (preferred.includes('tahoma')) {
    candidates.push(bold ? PDF_FONT_TAHOMA_BOLD : PDF_FONT_TAHOMA);
  }
  if (preferred.includes('segoe')) {
    candidates.push(bold ? PDF_FONT_SEGOE_BOLD : PDF_FONT_SEGOE);
  }

  candidates.push(bold ? PDF_FONT_BOLD : PDF_FONT_REGULAR);
  return candidates.find(filePath => fs.existsSync(filePath)) || null;
}

function setPdfFont(doc, bold = false, typography = 'Arial') {
  const fontPath = resolvePdfFontPath(typography, bold);
  if (fontPath && fs.existsSync(fontPath)) {
    return doc.font(fontPath);
  }
  return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
}

function fileExt(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isImageExtension(ext) {
  return IMAGE_EXTENSIONS.has(ext);
}

function isWebReadyImage(ext) {
  return WEB_IMAGE_EXTENSIONS.has(ext);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toWebPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function uniqueDestinationPath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let index = 2;
  while (fs.existsSync(`${base}_${index}${ext}`)) index += 1;
  return `${base}_${index}${ext}`;
}

function listOutputJobDirectories() {
  if (!fs.existsSync(OUTPUTS_DIR)) return [];
  return fs.readdirSync(OUTPUTS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
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
      sizeKB: Math.max(1, Math.round(stat.size / 1024)),
      isImage: isImageExtension(fileExt(name)),
    };
  });
}

function classifyFileType(fileName) {
  const ext = fileExt(fileName);
  const lowerName = String(fileName || '').toLowerCase();
  if (isImageExtension(ext)) return 'image';
  if (MODEL_EXTENSIONS.has(ext)) return 'model';
  if (ext === '.json' && lowerName.includes('geojson')) return 'map-data';
  if ((ext === '.json' && lowerName.includes('metadata')) || ext === '.txt' || ext === '.md') return ext === '.json' ? 'metadata' : 'report';
  if (MAP_EXTENSIONS.has(ext)) return 'map-data';
  if (DRAWING_EXTENSIONS.has(ext)) return 'drawing';
  if (REPORT_EXTENSIONS.has(ext)) return 'report';
  if (PRESENTATION_EXTENSIONS.has(ext)) return 'presentation';
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.zip') return 'archive';
  if (ext === '.json') return 'metadata';
  return 'document';
}

function classifyUsage(service, fileName) {
  const type = classifyFileType(fileName);
  if (service === 1 && type === 'image') return 'restored-visual';
  if (service === 2 && type === 'image') return 'architectural-visualization';
  if (service === 3 && type === 'image') return 'urban-view';
  if (service === 5 && type === 'image') return 'rendering';
  if (service === 5 && type === 'html') return 'interactive-viewer';
  if (service === 3 && type === 'html') return 'interactive-map';
  if (type === 'model') return '3d-model';
  if (type === 'drawing') return 'technical-drawing';
  if (type === 'spreadsheet') return 'data-sheet';
  if (type === 'presentation') return 'presentation';
  if (type === 'report') return 'documentation';
  if (type === 'html') return 'digital-output';
  if (type === 'map-data') return 'geospatial-data';
  return 'supporting-file';
}

function buildJobCatalogEntry(jobId, meta = {}) {
  const title = normalizeText(meta.buildingName)
    || normalizeText(meta.districtName)
    || normalizeText(meta.project?.title)
    || normalizeText(meta.project?.buildingName)
    || normalizeText(meta.project?.districtName)
    || normalizeText(meta.serviceName)
    || `Service ${meta.service || '?'} job`;

  const subtitleParts = [];
  if (meta.style) subtitleParts.push(meta.style);
  if (meta.buildingType) subtitleParts.push(meta.buildingType);
  if (meta.city) subtitleParts.push(meta.city);
  if (meta.period) subtitleParts.push(meta.period);
  if (meta.viewsGenerated) subtitleParts.push(`${meta.viewsGenerated} views`);
  if (meta.imageCount) subtitleParts.push(`${meta.imageCount} images`);

  return {
    jobId,
    service: meta.service || null,
    serviceName: meta.serviceName || SERVICE_NAMES[meta.service] || `Service ${meta.service || '?'}`,
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
    if (!meta || ![1, 2, 3, 4, 5].includes(meta.service)) continue;
    jobs.push(buildJobCatalogEntry(jobId, meta));
  }

  jobs.sort((a, b) => new Date(b.processedAt || 0) - new Date(a.processedAt || 0));
  return jobs;
}

function getRepresentativeImagePaths(meta, jobDir, files) {
  const imagePaths = [];

  if (Array.isArray(meta.outputFiles)) {
    for (const file of meta.outputFiles) {
      const ext = `.${String(file.ext || '').toLowerCase()}`;
      if (!isImageExtension(ext) && ext !== '.svg') continue;
      const local = publicPathFromUrl(file.url);
      if (fs.existsSync(local) && isImageExtension(fileExt(local))) imagePaths.push(local);
    }
  }

  if (!imagePaths.length) {
    for (const file of files) {
      if (file.isImage && isWebReadyImage(fileExt(file.path))) imagePaths.push(file.path);
    }
  }

  return [...new Set(imagePaths)].slice(0, 8);
}

function loadJobContext(jobId) {
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  const metaPath = path.join(jobDir, 'metadata.json');
  const meta = safeReadJson(metaPath);

  if (!meta) {
    throw new Error(`Job "${jobId}" does not contain readable metadata.`);
  }

  if (![1, 2, 3, 4, 5].includes(meta.service)) {
    throw new Error(`Job "${jobId}" is not a Service 01-05 output.`);
  }

  const files = collectOutputFiles(jobDir);
  const buildingName = normalizeText(meta.buildingName)
    || normalizeText(meta.project?.buildingName)
    || normalizeText(meta.project?.buildingNameArabic)
    || '';
  const districtName = normalizeText(meta.districtName)
    || normalizeText(meta.project?.districtName)
    || '';
  const title = normalizeText(buildingName)
    || normalizeText(districtName)
    || normalizeText(meta.project?.title)
    || normalizeText(meta.serviceName)
    || SERVICE_NAMES[meta.service];

  return {
    jobId,
    jobDir,
    service: meta.service,
    serviceName: meta.serviceName || SERVICE_NAMES[meta.service],
    title,
    buildingName,
    districtName,
    city: normalizeText(meta.city) || normalizeText(meta.project?.city) || normalizeText(meta.project?.location),
    processedAt: meta.processedAt || meta.generatedAt || '',
    metadata: meta,
    files: files.map(file => ({
      ...file,
      type: classifyFileType(file.name),
      usage: classifyUsage(meta.service, file.name),
    })),
    representativeImages: getRepresentativeImagePaths(meta, jobDir, files),
  };
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

function summarizeUploadedFiles(files = []) {
  const logos = [];
  const assets = [];
  const parsedMetadata = [];

  for (const file of files) {
    const ext = fileExt(file.originalname || file.path);
    const item = {
      fieldname: file.fieldname,
      originalName: file.originalname,
      storedPath: file.path,
      ext: ext.slice(1),
      sizeKB: Math.max(1, Math.round((file.size || 0) / 1024)),
      type: classifyFileType(file.originalname || file.path),
    };

    if (file.fieldname === 'logos') {
      logos.push(item);
      continue;
    }

    if (ext === '.json') {
      const parsed = safeReadJson(file.path);
      if (parsed && [1, 2, 3, 4, 5].includes(parsed.service)) {
        parsedMetadata.push(parsed);
      }
    }

    assets.push(item);
  }

  return {
    totalFiles: assets.length,
    logoCount: logos.length,
    assets,
    logos,
    parsedMetadata,
  };
}

function labelForLanguage(english, arabic, mode = 'english') {
  const language = normalizeText(mode, 'english').toLowerCase();
  if (language === 'arabic') return arabic;
  if (language === 'bilingual') return `${arabic} / ${english}`;
  return english;
}

function neutralizeServiceMentions(value = '', mode = 'english') {
  let text = String(value || '');
  if (!text) return text;

  const englishReplacements = [
    [/\bServices?\s*0?\d+(?:\s*(?:to|-|–)\s*0?\d+)?\b/gi, 'linked project outputs'],
    [/\bVisual Intelligence Restoration\b/gi, 'linked visual outputs'],
    [/\bArchitectural Rehabilitation Visualization\b/gi, 'linked architectural visuals'],
    [/\bGeospatial Analysis\s*&\s*Urban Fabric Restoration\b/gi, 'linked urban analysis outputs'],
    [/\bAutomated Academic Reporting\b/gi, 'linked report outputs'],
    [/\bComprehensive 3D Modeling\b/gi, 'linked 3D outputs'],
  ];
  const arabicReplacements = [
    [/الخدمات?\s*0?\d+(?:\s*(?:إلى|-|–)\s*0?\d+)?/g, 'المخرجات المرتبطة بالمشروع'],
    [/الخدمة\s*0?\d+/g, 'المخرج المرتبط'],
  ];

  for (const [pattern, replacement] of englishReplacements) {
    text = text.replace(pattern, replacement);
  }
  if (mode === 'arabic' || mode === 'bilingual') {
    for (const [pattern, replacement] of arabicReplacements) {
      text = text.replace(pattern, replacement);
    }
  }

  return text.replace(/\s{2,}/g, ' ').trim();
}

function localizeTemplateText(english, arabic, mode = 'english') {
  const language = normalizeText(mode, 'english').toLowerCase();
  if (language === 'arabic') return arabic;
  if (language === 'bilingual') return `${arabic}\n\n${english}`;
  return english;
}

function containsArabic(value = '') {
  return /[\u0600-\u06FF]/.test(String(value || ''));
}

function countArabicChars(value = '') {
  const matches = String(value || '').match(/[\u0600-\u06FF]/g);
  return matches ? matches.length : 0;
}

function countLatinChars(value = '') {
  const matches = String(value || '').match(/[A-Za-z]/g);
  return matches ? matches.length : 0;
}

function shouldFallbackEnglishText(value = '', options = {}) {
  const text = String(value || '').trim();
  if (!text || !containsArabic(text)) return false;

  const latinChars = countLatinChars(text);
  return Boolean(options.strictEnglish) || latinChars === 0 || countArabicChars(text) > (latinChars * 1.5);
}

function shouldFallbackArabicText(value = '', options = {}) {
  const text = String(value || '').trim();
  if (!text) return false;

  const arabicChars = countArabicChars(text);
  const latinChars = countLatinChars(text);
  if (!latinChars) return false;

  return Boolean(options.strictArabic)
    || arabicChars === 0
    || latinChars > Math.max(10, Math.floor(arabicChars * 0.35));
}

function sanitizeValueForLanguage(value = '', language = 'english', fallback = 'Not provided', options = {}) {
  const text = normalizeText(value, fallback);
  if (!text) return fallback;
  if (language === 'english' && shouldFallbackEnglishText(text, options)) return fallback;
  if (language === 'arabic' && shouldFallbackArabicText(text, options)) return fallback;
  return text;
}

function sanitizeMultilineForLanguage(value = '', language = 'english', fallback = 'Not provided.', options = {}) {
  const text = normalizeMultiline(value, fallback);
  if (!text) return fallback;
  if (language === 'english' && shouldFallbackEnglishText(text, options)) return fallback;
  if (language === 'arabic' && shouldFallbackArabicText(text, options)) return fallback;
  return text;
}

function sanitizeTextByMode(value, mode, englishFallback, arabicFallback, options = {}) {
  const language = normalizeText(mode, 'english').toLowerCase();
  if (language === 'arabic') {
    return sanitizeMultilineForLanguage(value, 'arabic', arabicFallback, { strictArabic: true, ...options });
  }
  if (language === 'english') {
    return sanitizeMultilineForLanguage(value, 'english', englishFallback, { strictEnglish: true, ...options });
  }
  return normalizeMultiline(value, `${arabicFallback}\n\n${englishFallback}`);
}

const ARABIC_DIACRITIC_RE = /[\u064B-\u065F\u0670\u06D6-\u06ED]/;
const ARABIC_SHAPING_MAP = {
  'ء': { isolated: '\uFE80', final: '\uFE80', joinsToPrev: false, joinsToNext: false },
  'آ': { isolated: '\uFE81', final: '\uFE82', joinsToPrev: true, joinsToNext: false },
  'أ': { isolated: '\uFE83', final: '\uFE84', joinsToPrev: true, joinsToNext: false },
  'ؤ': { isolated: '\uFE85', final: '\uFE86', joinsToPrev: true, joinsToNext: false },
  'إ': { isolated: '\uFE87', final: '\uFE88', joinsToPrev: true, joinsToNext: false },
  'ئ': { isolated: '\uFE89', final: '\uFE8A', initial: '\uFE8B', medial: '\uFE8C', joinsToPrev: true, joinsToNext: true },
  'ا': { isolated: '\uFE8D', final: '\uFE8E', joinsToPrev: true, joinsToNext: false },
  'ب': { isolated: '\uFE8F', final: '\uFE90', initial: '\uFE91', medial: '\uFE92', joinsToPrev: true, joinsToNext: true },
  'ة': { isolated: '\uFE93', final: '\uFE94', joinsToPrev: true, joinsToNext: false },
  'ت': { isolated: '\uFE95', final: '\uFE96', initial: '\uFE97', medial: '\uFE98', joinsToPrev: true, joinsToNext: true },
  'ث': { isolated: '\uFE99', final: '\uFE9A', initial: '\uFE9B', medial: '\uFE9C', joinsToPrev: true, joinsToNext: true },
  'ج': { isolated: '\uFE9D', final: '\uFE9E', initial: '\uFE9F', medial: '\uFEA0', joinsToPrev: true, joinsToNext: true },
  'ح': { isolated: '\uFEA1', final: '\uFEA2', initial: '\uFEA3', medial: '\uFEA4', joinsToPrev: true, joinsToNext: true },
  'خ': { isolated: '\uFEA5', final: '\uFEA6', initial: '\uFEA7', medial: '\uFEA8', joinsToPrev: true, joinsToNext: true },
  'د': { isolated: '\uFEA9', final: '\uFEAA', joinsToPrev: true, joinsToNext: false },
  'ذ': { isolated: '\uFEAB', final: '\uFEAC', joinsToPrev: true, joinsToNext: false },
  'ر': { isolated: '\uFEAD', final: '\uFEAE', joinsToPrev: true, joinsToNext: false },
  'ز': { isolated: '\uFEAF', final: '\uFEB0', joinsToPrev: true, joinsToNext: false },
  'س': { isolated: '\uFEB1', final: '\uFEB2', initial: '\uFEB3', medial: '\uFEB4', joinsToPrev: true, joinsToNext: true },
  'ش': { isolated: '\uFEB5', final: '\uFEB6', initial: '\uFEB7', medial: '\uFEB8', joinsToPrev: true, joinsToNext: true },
  'ص': { isolated: '\uFEB9', final: '\uFEBA', initial: '\uFEBB', medial: '\uFEBC', joinsToPrev: true, joinsToNext: true },
  'ض': { isolated: '\uFEBD', final: '\uFEBE', initial: '\uFEBF', medial: '\uFEC0', joinsToPrev: true, joinsToNext: true },
  'ط': { isolated: '\uFEC1', final: '\uFEC2', initial: '\uFEC3', medial: '\uFEC4', joinsToPrev: true, joinsToNext: true },
  'ظ': { isolated: '\uFEC5', final: '\uFEC6', initial: '\uFEC7', medial: '\uFEC8', joinsToPrev: true, joinsToNext: true },
  'ع': { isolated: '\uFEC9', final: '\uFECA', initial: '\uFECB', medial: '\uFECC', joinsToPrev: true, joinsToNext: true },
  'غ': { isolated: '\uFECD', final: '\uFECE', initial: '\uFECF', medial: '\uFED0', joinsToPrev: true, joinsToNext: true },
  'ف': { isolated: '\uFED1', final: '\uFED2', initial: '\uFED3', medial: '\uFED4', joinsToPrev: true, joinsToNext: true },
  'ق': { isolated: '\uFED5', final: '\uFED6', initial: '\uFED7', medial: '\uFED8', joinsToPrev: true, joinsToNext: true },
  'ك': { isolated: '\uFED9', final: '\uFEDA', initial: '\uFEDB', medial: '\uFEDC', joinsToPrev: true, joinsToNext: true },
  'ل': { isolated: '\uFEDD', final: '\uFEDE', initial: '\uFEDF', medial: '\uFEE0', joinsToPrev: true, joinsToNext: true },
  'م': { isolated: '\uFEE1', final: '\uFEE2', initial: '\uFEE3', medial: '\uFEE4', joinsToPrev: true, joinsToNext: true },
  'ن': { isolated: '\uFEE5', final: '\uFEE6', initial: '\uFEE7', medial: '\uFEE8', joinsToPrev: true, joinsToNext: true },
  'ه': { isolated: '\uFEE9', final: '\uFEEA', initial: '\uFEEB', medial: '\uFEEC', joinsToPrev: true, joinsToNext: true },
  'و': { isolated: '\uFEED', final: '\uFEEE', joinsToPrev: true, joinsToNext: false },
  'ى': { isolated: '\uFEEF', final: '\uFEF0', joinsToPrev: true, joinsToNext: false },
  'ي': { isolated: '\uFEF1', final: '\uFEF2', initial: '\uFEF3', medial: '\uFEF4', joinsToPrev: true, joinsToNext: true },
};
const ARABIC_LAM_ALEF_LIGATURES = {
  'آ': { isolated: '\uFEF5', final: '\uFEF6' },
  'أ': { isolated: '\uFEF7', final: '\uFEF8' },
  'إ': { isolated: '\uFEF9', final: '\uFEFA' },
  'ا': { isolated: '\uFEFB', final: '\uFEFC' },
};
const RTL_MIRRORING_MAP = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '«': '»',
  '»': '«',
};

function isArabicDiacritic(value = '') {
  return ARABIC_DIACRITIC_RE.test(String(value || ''));
}

function getArabicJoiningInfo(value = '') {
  return ARABIC_SHAPING_MAP[String(value || '')] || null;
}

function getArabicNeighbor(chars, startIndex, step) {
  for (let index = startIndex + step; index >= 0 && index < chars.length; index += step) {
    const char = chars[index];
    if (isArabicDiacritic(char)) continue;
    return { index, char };
  }
  return null;
}

function canArabicCharsJoin(leftChar, rightChar) {
  const left = getArabicJoiningInfo(leftChar);
  const right = getArabicJoiningInfo(rightChar);
  return Boolean(left && right && left.joinsToNext && right.joinsToPrev);
}

function shapeArabicRun(value = '') {
  const chars = [...String(value || '')];
  const output = [];

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (isArabicDiacritic(char)) {
      output.push(char);
      continue;
    }

    const current = getArabicJoiningInfo(char);
    if (!current) {
      output.push(char);
      continue;
    }

    const previous = getArabicNeighbor(chars, index, -1);
    const next = getArabicNeighbor(chars, index, 1);
    const lamAlefLigature = char === 'ل' && next ? ARABIC_LAM_ALEF_LIGATURES[next.char] : null;

    if (lamAlefLigature) {
      const joinsPrevious = previous ? canArabicCharsJoin(previous.char, char) : false;
      output.push(joinsPrevious ? lamAlefLigature.final : lamAlefLigature.isolated);
      for (let skipped = index + 1; skipped < next.index; skipped += 1) {
        output.push(chars[skipped]);
      }
      index = next.index;
      continue;
    }

    const joinsPrevious = previous ? canArabicCharsJoin(previous.char, char) : false;
    const joinsNext = next ? canArabicCharsJoin(char, next.char) : false;
    if (joinsPrevious && joinsNext && current.medial) {
      output.push(current.medial);
    } else if (joinsPrevious && current.final) {
      output.push(current.final);
    } else if (joinsNext && current.initial) {
      output.push(current.initial);
    } else {
      output.push(current.isolated || char);
    }
  }

  return output.join('');
}

function reverseGlyphClusters(value = '') {
  const clusters = [];
  let cluster = '';

  for (const char of [...String(value || '')]) {
    if (!cluster) {
      cluster = char;
      continue;
    }

    if (isArabicDiacritic(char)) {
      cluster += char;
      continue;
    }

    clusters.push(cluster);
    cluster = char;
  }

  if (cluster) clusters.push(cluster);
  return clusters.reverse().join('');
}

function tokenizeDirectionalLine(value = '') {
  const tokens = [];
  let current = '';
  let kind = '';

  const pushToken = () => {
    if (!current) return;
    tokens.push({ value: current, kind });
    current = '';
    kind = '';
  };

  for (const char of [...String(value || '')]) {
    let nextKind = 'neutral';
    if (/\s/.test(char)) {
      nextKind = 'space';
    } else if (containsArabic(char) || isArabicDiacritic(char)) {
      nextKind = 'rtl';
    } else if (/[A-Za-z0-9]/.test(char) || /[_./:+#@%&=\\-]/.test(char)) {
      nextKind = 'ltr';
    }

    if (current && nextKind !== kind) pushToken();
    current += char;
    kind = nextKind;
  }

  pushToken();
  return tokens;
}

function shapeVisualRtlLine(value = '') {
  const tokens = tokenizeDirectionalLine(value);
  if (!tokens.some(token => token.kind === 'rtl')) return String(value || '');

  return tokens
    .reverse()
    .map(token => {
      if (token.kind === 'rtl') return reverseGlyphClusters(shapeArabicRun(token.value));
      if (token.kind === 'neutral') {
        return [...token.value].map(char => RTL_MIRRORING_MAP[char] || char).join('');
      }
      return token.value;
    })
    .join('');
}

function formatVisualRtlText(value = '', language = 'english') {
  const text = String(value || '');
  if (!text || !isRtlLanguage(language) || !containsArabic(text)) return text;
  return text.split(/\r?\n/).map(line => shapeVisualRtlLine(line)).join('\n');
}

function prefersRtlText(value = '', mode = 'english', options = {}) {
  if (options.forceRtl === true) {
    const text = String(value || '').trim();
    return containsArabic(text) || (isRtlLanguage(mode) && !countLatinChars(text));
  }
  if (options.forceRtl === false) return false;

  const text = String(value || '').trim();
  if (!text) return Boolean(options.preferDocumentDirection && isRtlLanguage(mode));

  const arabicChars = countArabicChars(text);
  const latinChars = countLatinChars(text);
  if (arabicChars > 0) return arabicChars >= Math.max(1, Math.floor(latinChars * 0.6));
  if (isRtlLanguage(mode) && !latinChars && !textContainsLatinOrDigits(text)) {
    return Boolean(options.preferDocumentDirection);
  }
  return false;
}

function htmlDirectionForText(value = '', mode = 'english', options = {}) {
  return prefersRtlText(value, mode, { preferDocumentDirection: true, ...options }) ? 'rtl' : 'ltr';
}

function htmlDirectionAttrs(value = '', mode = 'english', options = {}) {
  const dir = htmlDirectionForText(value, mode, options);
  return `dir="${dir}" class="${dir === 'rtl' ? 'rtl-block' : 'ltr-block'}"`;
}

function capturePdfPages(doc, writer, onPageUsed) {
  const before = doc.bufferedPageRange().count;
  writer();
  const after = doc.bufferedPageRange().count;
  const start = Math.max(0, before - 1);
  const end = Math.max(start, after - 1);
  for (let index = start; index <= end; index += 1) {
    onPageUsed(index);
  }
}

function trimTrailingBufferedPages(doc, pageIndexes = new Set()) {
  const range = doc.bufferedPageRange();
  let lastUsedPage = range.count - 1;
  if (pageIndexes.size) {
    lastUsedPage = Math.max(...pageIndexes);
  }

  const finalPageCount = Math.max(1, lastUsedPage + 1);
  if (Array.isArray(doc._pageBuffer) && finalPageCount < doc._pageBuffer.length) {
    doc._pageBuffer.splice(finalPageCount);

    const pages = doc?._root?.data?.Pages?.data;
    if (pages && Array.isArray(pages.Kids) && typeof pages.Count === 'number') {
      pages.Kids.splice(finalPageCount);
      pages.Count = Math.min(pages.Count, finalPageCount);
    }

    doc.switchToPage(finalPageCount - 1);
  }

  return finalPageCount;
}

function formatPdfRtlLine(line = '') {
  const tokens = String(line)
    .split(/(\s+)/)
    .filter(token => token.length > 0);

  return tokens.reverse().join('');
}

function formatPdfText(value = '', language = 'english') {
  const rtlLike = language === 'arabic' || language === 'bilingual';
  if (!rtlLike) return String(value || '');

  return String(value || '')
    .split('\n')
    .map(line => (containsArabic(line) ? formatPdfRtlLine(line) : line))
    .join('\n');
}

function localizedAssetType(type, mode = 'english') {
  return labelForLanguage(type, ({
    image: 'صورة',
    model: 'نموذج',
    'map-data': 'بيانات خرائط',
    metadata: 'بيانات وصفية',
    drawing: 'رسم تقني',
    report: 'تقرير',
    presentation: 'عرض تقديمي',
    spreadsheet: 'جدول بيانات',
    html: 'محتوى ويب',
    archive: 'أرشيف',
    document: 'مستند',
  })[type] || 'ملف', mode);
}

function getNeutralSourceLabel(source = {}, mode = 'english') {
  if (source.sourceKind === 'upload') {
    return labelForLanguage('Manual upload', 'رفع يدوي', mode);
  }

  const preferred = neutralizeServiceMentions(
    normalizeText(source.title)
      || normalizeText(source.building)
      || normalizeText(source.district)
      || normalizeText(source.jobId)
      || labelForLanguage('Linked source', 'مصدر مرتبط', mode),
    mode,
  );

  return preferred || labelForLanguage('Linked source', 'مصدر مرتبط', mode);
}

function localizedLanguageMode(mode = 'english', outputLanguage = mode) {
  const normalizedMode = normalizeText(mode, 'english').toLowerCase();
  if (outputLanguage === 'arabic') {
    return {
      english: 'الإنجليزية',
      arabic: 'العربية',
      bilingual: 'ثنائية اللغة',
    }[normalizedMode] || normalizedMode;
  }
  if (outputLanguage === 'bilingual') {
    return {
      english: 'العربية / English',
      arabic: 'العربية / Arabic',
      bilingual: 'ثنائية اللغة / Bilingual',
    }[normalizedMode] || normalizedMode;
  }
  return {
    english: 'English',
    arabic: 'Arabic',
    bilingual: 'Bilingual',
  }[normalizedMode] || normalizedMode;
}

function isRtlLanguage(mode = 'english') {
  const language = normalizeText(mode, 'english').toLowerCase();
  return language === 'arabic' || language === 'bilingual';
}

function textContainsLatinOrDigits(value = '') {
  return /[A-Za-z0-9]/.test(String(value || ''));
}

function fontFamilyStack(typography = 'Arial', mode = 'english') {
  const preferred = normalizeText(typography, 'Arial');
  const common = isRtlLanguage(mode)
    ? [`"${preferred}"`, '"Cairo"', '"Segoe UI"', 'Tahoma', 'Arial', 'sans-serif']
    : [`"${preferred}"`, '"Segoe UI"', 'Arial', 'sans-serif'];
  return [...new Set(common)].join(', ');
}

function prepareDirectionalText(value = '', mode = 'english') {
  const text = String(value || '');
  if (!text) return text;
  if (!isRtlLanguage(mode) || !containsArabic(text)) return text;

  return text
    .split(/\r?\n/)
    .map(line => line.replace(
      /([A-Za-z0-9][A-Za-z0-9_./:+#@%&=()\-]*)/g,
      segment => `\u2066${segment}\u2069`,
    ))
    .join('\n');
}

function splitNarrativeParagraphs(value = '') {
  return String(value || '')
    .split(/\n\s*\n/)
    .map(part => part.trim())
    .filter(Boolean);
}

function wordFontOptions(context) {
  const typeface = normalizeText(context?.brand?.typography, 'Arial');
  return {
    ascii: typeface,
    hAnsi: typeface,
    eastAsia: typeface,
    cs: typeface,
  };
}

function createWordParagraph(text, context, options = {}) {
  const forceRtl = prefersRtlText(text, context.brand.languageMode, {
    forceRtl: options.forceRtl,
    preferDocumentDirection: options.preferDocumentDirection !== false,
  });
  const alignment = options.alignment === AlignmentType.CENTER
    ? AlignmentType.CENTER
    : options.autoAlign === false && options.alignment
      ? options.alignment
      : (forceRtl ? AlignmentType.RIGHT : AlignmentType.LEFT);
  const runOptions = {
    text: prepareDirectionalText(text, context.brand.languageMode),
    bold: Boolean(options.bold),
    font: wordFontOptions(context),
    rightToLeft: forceRtl,
    language: forceRtl ? { value: 'ar-SA', eastAsia: 'ar-SA', bidi: 'ar-SA' } : { value: 'en-US', eastAsia: 'en-US' },
  };
  if (options.size) runOptions.size = options.size;
  const paragraphOptions = {
    alignment,
    heading: options.heading,
    bidirectional: forceRtl,
    spacing: options.spacing || { line: 360, before: 120, after: 120 },
    children: [
      new TextRun(runOptions),
    ],
  };
  if (!paragraphOptions.heading) delete paragraphOptions.heading;
  return new Paragraph(paragraphOptions);
}

function summarizeAssetMix(assets = [], mode = 'english') {
  const counts = assets.reduce((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});

  const order = ['image', 'drawing', 'report', 'model', 'map-data', 'presentation', 'spreadsheet', 'html'];
  const parts = order
    .filter(type => counts[type])
    .map(type => localizeTemplateText(
      `${counts[type]} ${type.replace('-', ' ')}`,
      `${counts[type]} ${localizedAssetType(type, 'arabic')}`,
      mode,
    ));

  return parts.join(mode === 'arabic' ? '، ' : ', ');
}

function describeBuildingRecord(name, assets, brand) {
  const relatedSources = [...new Set(assets.map(asset => asset.sourceLabel).filter(Boolean))];
  const typeMix = summarizeAssetMix(assets, brand.languageMode);
  const hasVisuals = assets.some(asset => asset.type === 'image');
  const hasDrawings = assets.some(asset => asset.type === 'drawing');
  const hasReports = assets.some(asset => asset.type === 'report');
  const hasModels = assets.some(asset => asset.type === 'model' || asset.usage === 'interactive-viewer');
  const limitations = [];

  if (!hasDrawings) {
    limitations.push(localizeTemplateText(
      'no linked technical drawing set was available',
      'لم تتوفر مجموعة رسومات فنية مرتبطة',
      brand.languageMode,
    ));
  }
  if (!hasReports) {
    limitations.push(localizeTemplateText(
      'narrative analytical reporting remains limited',
      'يبقى السرد التحليلي محدودا',
      brand.languageMode,
    ));
  }

  const limitationLine = limitations.length
    ? localizeTemplateText(
      `Current limitations: ${limitations.join('; ')}.`,
      `القيود الحالية: ${limitations.join('؛ ')}.`,
      brand.languageMode,
    )
    : localizeTemplateText(
      'The available evidence supports a coherent building-level documentation record for review, coordination, and presentation use.',
      'تدعم الأدلة المتاحة إعداد سجل توثيقي متماسك على مستوى المبنى يصلح للمراجعة والتنسيق والعرض.',
      brand.languageMode,
    );

  return localizeTemplateText(
    `${name} is documented through ${assets.length} linked file(s) drawn from ${relatedSources.join(', ') || 'the available source sets'}. The current record includes ${typeMix || 'supporting project files'}. ${hasVisuals ? 'Visual evidence is available.' : 'Visual evidence is limited.'} ${hasModels ? 'Three-dimensional or interactive material is also present.' : ''} ${limitationLine}`,
    `يوثق ${name} من خلال ${assets.length} ملفا مرتبطا مستمدا من ${relatedSources.join('، ') || 'المصادر المتاحة'}. ويشمل السجل الحالي ${typeMix || 'ملفات مساندة للمشروع'}. ${hasVisuals ? 'تتوفر أدلة بصرية ضمن هذا السجل.' : 'الأدلة البصرية ضمن هذا السجل محدودة.'} ${hasModels ? 'كما تتوفر مواد ثلاثية الأبعاد أو تفاعلية.' : ''} ${limitationLine}`,
    brand.languageMode,
  ).replace(/\s{2,}/g, ' ').trim();
}

function buildCoverageModel(linkedJobs, contentModel) {
  const usages = contentModel.assets.reduce((acc, asset) => {
    acc[asset.usage] = (acc[asset.usage] || 0) + 1;
    return acc;
  }, {});

  return {
    hasVisualReferences: Boolean(findFirstJob(linkedJobs, 1)) || Boolean(contentModel.counts.images),
    hasUrbanAnalysis: Boolean(findFirstJob(linkedJobs, 3)) || Boolean(contentModel.counts.maps),
    hasStructuredReporting: Boolean(findFirstJob(linkedJobs, 4)) || Boolean(contentModel.counts.reports),
    hasThreeDimensionalOutputs: Boolean(findFirstJob(linkedJobs, 5)) || Boolean(contentModel.counts.models),
    visualCount: contentModel.counts.images,
    drawingCount: contentModel.counts.drawings,
    reportCount: contentModel.counts.reports,
    modelCount: contentModel.counts.models,
    mapCount: contentModel.counts.maps,
    interactiveCount: (usages['interactive-map'] || 0) + (usages['interactive-viewer'] || 0),
  };
}

function buildBrandProfile(input, uploadedFilesSummary) {
  return {
    projectName: normalizeText(input.projectName, 'RUAA Heritage Documentation Package'),
    implementingBody: normalizeText(input.implementingBody, 'Not provided'),
    preparationDate: normalizeText(input.preparationDate, new Date().toISOString().slice(0, 10)),
    consultantTeam: normalizeText(input.consultantTeam, 'Not provided'),
    languageMode: normalizeText(input.languageMode, 'bilingual').toLowerCase(),
    primaryColor: normalizeText(input.primaryColor, '#1A3554'),
    accentColor: normalizeText(input.accentColor, '#DFAF67'),
    supportColor: normalizeText(input.supportColor, '#E8F1F8'),
    typography: normalizeText(input.typography, 'Cairo'),
    brandingPreferences: normalizeMultiline(input.brandingPreferences, 'Professional heritage-oriented identity with clear hierarchy and presentation-ready formatting.'),
    exportPreferences: parseCsvList(input.exportPreferences || 'pdf,word,pptx,html,xlsx,zip'),
    logos: uploadedFilesSummary.logos,
  };
}

function buildContentModel(project, linkedJobs, uploadedFilesSummary, languageMode = 'english') {
  const assets = [];

  for (const job of linkedJobs) {
    for (const file of job.files) {
      assets.push({
        id: `${job.jobId}:${file.name}`,
        sourceKind: 'linked-job',
        service: job.service,
        serviceName: job.serviceName,
        sourceLabel: getNeutralSourceLabel(job, languageMode),
        jobId: job.jobId,
        title: job.title,
        building: normalizeText(job.buildingName, 'Project-wide'),
        district: normalizeText(job.districtName, 'Project-wide'),
        city: normalizeText(job.city),
        name: file.name,
        path: file.path,
        ext: file.ext,
        sizeKB: file.sizeKB,
        type: file.type,
        usage: file.usage,
      });
    }
  }

  for (const file of uploadedFilesSummary.assets) {
    assets.push({
      id: `upload:${file.originalName}:${file.sizeKB}`,
      sourceKind: 'upload',
      service: 0,
      serviceName: 'Manual Upload',
      sourceLabel: getNeutralSourceLabel({ sourceKind: 'upload' }, languageMode),
      jobId: null,
      title: project.projectName,
      building: normalizeText(project.defaultBuildingName, 'Project-wide'),
      district: normalizeText(project.defaultDistrictName, 'Project-wide'),
      city: normalizeText(project.projectLocation),
      name: file.originalName,
      path: file.storedPath,
      ext: file.ext,
      sizeKB: file.sizeKB,
      type: file.type,
      usage: classifyUsage(0, file.originalName),
    });
  }

  const grouped = key => assets.reduce((acc, asset) => {
    const value = normalizeText(asset[key], 'Project-wide');
    if (!acc[value]) acc[value] = [];
    acc[value].push(asset);
    return acc;
  }, {});

  const byType = assets.reduce((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});

  const bySource = assets.reduce((acc, asset) => {
    const label = asset.sourceLabel || labelForLanguage('Linked source', 'مصدر مرتبط', languageMode);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return {
    assets,
    byBuilding: grouped('building'),
    byDistrict: grouped('district'),
    byType,
    bySource,
    counts: {
      totalAssets: assets.length,
      images: assets.filter(asset => asset.type === 'image').length,
      reports: assets.filter(asset => asset.type === 'report').length,
      drawings: assets.filter(asset => asset.type === 'drawing').length,
      models: assets.filter(asset => asset.type === 'model').length,
      maps: assets.filter(asset => asset.type === 'map-data').length,
      presentations: assets.filter(asset => asset.type === 'presentation').length,
      spreadsheets: assets.filter(asset => asset.type === 'spreadsheet').length,
      html: assets.filter(asset => asset.type === 'html').length,
    },
  };
}

function findFirstJob(linkedJobs, service) {
  return linkedJobs.find(job => job.service === service) || null;
}

function buildProjectContext(input, linkedJobs, uploadedFilesSummary) {
  const service2 = findFirstJob(linkedJobs, 2);
  const service3 = findFirstJob(linkedJobs, 3);
  const service4 = findFirstJob(linkedJobs, 4);
  const service5 = findFirstJob(linkedJobs, 5);
  const brand = buildBrandProfile(input, uploadedFilesSummary);
  const languageMode = brand.languageMode;

  const project = {
    projectName: normalizeText(input.projectName, normalizeText(service4?.metadata?.project?.buildingName) || normalizeText(service5?.metadata?.project?.title) || 'RUAA Heritage Documentation Package'),
    implementingBody: normalizeText(input.implementingBody, 'Not provided'),
    preparationDate: normalizeText(input.preparationDate, new Date().toISOString().slice(0, 10)),
    consultantTeam: normalizeText(input.consultantTeam, 'Not provided'),
    projectLocation: normalizeText(input.projectLocation, normalizeText(service3?.city) || normalizeText(service4?.metadata?.project?.location)),
    defaultBuildingName: normalizeText(input.defaultBuildingName, normalizeText(service2?.buildingName) || normalizeText(service4?.metadata?.project?.buildingName)),
    defaultDistrictName: normalizeText(input.defaultDistrictName, normalizeText(service3?.districtName) || normalizeText(service5?.metadata?.project?.districtName)),
    brandingPreferences: normalizeMultiline(input.brandingPreferences, 'Professional communication package suitable for official, academic, and presentation use.'),
    exportPreferences: parseCsvList(input.exportPreferences || 'pdf,word,pptx,html,xlsx,zip'),
    notes: normalizeMultiline(input.notes, 'No additional project notes were provided.'),
  };

  return {
    project: {
      ...project,
      brandingPreferences: sanitizeTextByMode(
        project.brandingPreferences,
        languageMode,
        'Professional communication package suitable for official, academic, and presentation use.',
        'حزمة تواصل مهنية مناسبة للاستخدام الرسمي والأكاديمي والعرض التقديمي.',
      ),
      notes: sanitizeTextByMode(
        project.notes,
        languageMode,
        'No additional project notes were provided.',
        'لم يتم تقديم ملاحظات إضافية حول المشروع.',
      ),
    },
    brand,
  };
}

function buildBuildingRecords(contentModel, linkedJobs, brand) {
  const entries = Object.entries(contentModel.byBuilding)
    .filter(([name]) => normalizeText(name) && name !== 'Project-wide');

  if (!entries.length) {
    return [{
      name: normalizeText(brand.projectName, 'General Building File'),
      assets: contentModel.assets.slice(0, 24),
      summary: localizeTemplateText(
        'No building-specific names were provided, so a general building documentation file will be generated from the full project package.',
        'لم يتم تقديم أسماء محددة للمباني، لذلك سيتم إنشاء ملف توثيقي عام للمبنى اعتماداً على حزمة المشروع الكاملة.',
        brand.languageMode,
      ),
    }];
  }

  return entries.map(([name, assets]) => {
    const relatedSources = [...new Set(assets.map(asset => asset.sourceLabel).filter(Boolean))];
    return {
      name,
      assets,
      summary: localizeTemplateText(
        `${name} consolidates ${assets.length} files from ${relatedSources.join(', ') || 'project source sets'}.`,
        `يجمع ملف ${name} عدد ${assets.length} من الملفات من ${relatedSources.join('، ') || 'حزم المصادر المرتبطة بالمشروع'}.`,
        brand.languageMode,
      ),
    };
  });
}

function buildDossierModel(context, linkedJobs, contentModel) {
  const languageMode = context.brand.languageMode;
  const buildingRecords = buildBuildingRecords(contentModel, linkedJobs, context.brand);
  const service3 = findFirstJob(linkedJobs, 3);
  const service4 = findFirstJob(linkedJobs, 4);
  const service5 = findFirstJob(linkedJobs, 5);
  const totalJobs = linkedJobs.length;
  const typeSummary = Object.entries(contentModel.byType)
    .map(([type, count]) => `${localizedAssetType(type, languageMode)}: ${count}`)
    .join(', ');

  const sections = [
    {
      id: 'front_matter',
      title: labelForLanguage('Front Matter', 'التمهيد', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} was prepared for ${context.brand.implementingBody}. Date of preparation: ${context.brand.preparationDate}. Consultant / researcher team: ${context.brand.consultantTeam}.`,
        `أُعد ${context.brand.projectName} لصالح ${context.brand.implementingBody}. تاريخ الإعداد: ${context.brand.preparationDate}. الفريق الاستشاري / البحثي: ${context.brand.consultantTeam}.`,
        languageMode,
      ),
    },
    {
      id: 'project_overview',
      title: labelForLanguage('Project Overview', 'نظرة عامة على المشروع', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} aggregates ${contentModel.counts.totalAssets} deliverable files from ${totalJobs} linked source package(s). The package is organized for documentation, presentation, publication, review, and digital delivery.`,
        `يجمع ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من ملفات المخرجات من ${totalJobs} مهمة مرتبطة ضمن مراحل المشروع المختلفة. وقد تم تنظيم الحزمة لأغراض التوثيق والعرض والنشر والمراجعة والتسليم الرقمي.`,
        languageMode,
      ),
    },
    {
      id: 'historical_context',
      title: labelForLanguage('Historical and Geographic Context', 'السياق التاريخي والجغرافي', languageMode),
      body: service3
        ? localizeTemplateText(
          `${normalizeText(service3.metadata?.districtName, 'The project area')} in ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'the referenced location')} is represented through district-scale urban analysis, terrain-aware mapping, and heritage-fabric interpretation.`,
          `يتم تمثيل ${normalizeText(service3.metadata?.districtName, 'منطقة المشروع')} في ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'الموقع المرجعي')} من خلال تحليل عمراني على مستوى النطاق، وخرائط تراعي التضاريس، وقراءة للنسيج التراثي.`,
          languageMode,
        )
        : localizeTemplateText(
          'Historical and geographic context should be read alongside the linked reports and maps packaged in this delivery. The current implementation preserves and indexes the available source materials even when structured narrative metadata is limited.',
          'يُقرأ السياق التاريخي والجغرافي بالتوازي مع التقارير والخرائط المرتبطة والمضمنة في هذه الحزمة. وتحافظ البنية الحالية على المواد المرجعية المتاحة وتفهرسها حتى عند محدودية البيانات السردية المنظمة.',
          languageMode,
        ),
    },
    {
      id: 'building_chapters',
      title: labelForLanguage('Building Chapters', 'فصول المباني', languageMode),
      body: localizeTemplateText(
        `Building-level documentation has been generated for ${buildingRecords.length} building group(s). Each document consolidates before/after visuals where available, linked drawings, analytical references, 3D views, and implementation notes.`,
        `تم إعداد توثيق على مستوى المباني لعدد ${buildingRecords.length} مجموعة مبانٍ. ويجمع كل ملف اللقطات المرجعية قبل/بعد عند توفرها، والرسومات المرتبطة، والمراجع التحليلية، والمشاهد ثلاثية الأبعاد، وملاحظات التنفيذ.`,
        languageMode,
      ),
    },
    {
      id: 'urban_analysis',
      title: labelForLanguage('Urban Fabric Analysis', 'تحليل النسيج العمراني', languageMode),
      body: service3
        ? localizeTemplateText(
          `Urban outputs include district plans, geospatial datasets, analytical maps, and interactive portfolio material. District-scale coverage includes ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          `تشمل المخرجات العمرانية مخططات النطاق، وبيانات جغرافية مكانية، وخرائط تحليلية، ومواد تفاعلية للمحفظة الرقمية. ويشمل نطاق التغطية العمرانية: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          languageMode,
        )
        : localizeTemplateText(
          'Urban analysis assets were not explicitly linked, but the dossier structure reserves a dedicated section so district-scale materials can be integrated consistently when present.',
          'لم يتم ربط مواد التحليل العمراني بشكل صريح، إلا أن بنية الوثيقة تحتفظ بقسم مخصص لها بحيث يمكن دمج مواد النطاق العمراني بشكل متسق عند توفرها.',
          languageMode,
        ),
    },
    {
      id: 'standards_compliance',
      title: labelForLanguage('Standards and Compliance Analysis', 'تحليل المعايير والامتثال', languageMode),
      body: service4
        ? localizeTemplateText(
          'Linked standards-oriented report outputs are integrated as supporting evidence for references, methodology, and compliance-oriented communication.',
          'تم دمج المخرجات المرتبطة ذات الصلة بالمعايير باعتبارها أدلة مساندة للمراجع والمنهجية والصياغة الموجهة للامتثال.',
          languageMode,
        )
        : localizeTemplateText(
          'This package provides placeholders and structured appendices for standards and compliance analysis; richer narrative interpretation can be layered from linked reports or external policy review when required.',
          'توفر هذه الحزمة مواضع مهيكلة وملاحق منظمة لتحليل المعايير والامتثال، ويمكن إثراؤها لاحقاً بسرد أكثر عمقاً اعتماداً على التقارير المرتبطة أو المراجعات التنظيمية الخارجية عند الحاجة.',
          languageMode,
        ),
    },
    {
      id: 'implementation_plan',
      title: labelForLanguage('Implementation Plan', 'خطة التنفيذ', languageMode),
      body: localizeTemplateText(
        'The delivery package separates source imagery, technical drawings, 3D models, reports, presentations, dossier outputs, digital portfolio files, and media assets into a controlled handover structure. This supports phased review, printing, presentation, and downstream refinement.',
        'تفصل حزمة التسليم بين الصور المرجعية، والرسومات التقنية، والنماذج ثلاثية الأبعاد، والتقارير، والعروض التقديمية، ومخرجات الوثيقة الشاملة، وملفات المحفظة الرقمية، والمواد الإعلامية ضمن هيكل تسليم منظم. ويدعم ذلك المراجعة المرحلية والطباعة والعرض والتطوير اللاحق.',
        languageMode,
      ),
    },
    {
      id: 'conclusion',
      title: labelForLanguage('Conclusion', 'الخاتمة', languageMode),
      body: localizeTemplateText(
        `This documentation and media package transforms technical project outputs into a communication-ready documentation set with clear branding, delivery indexing, reusable building templates, and digital-ready presentation outputs. Current file-type coverage: ${typeSummary}.`,
        `تحول هذه الحزمة التوثيقية والإعلامية مخرجات المشروع التقنية إلى مجموعة توثيقية جاهزة للتواصل والعرض بهوية واضحة وفهرسة للتسليم وقوالب قابلة لإعادة الاستخدام للمباني ومخرجات مناسبة للعروض الرقمية. ويشمل نطاق أنواع الملفات الحالية: ${typeSummary}.`,
        languageMode,
      ),
    },
  ];

  const references = [
    ...linkedJobs.map(job => ({
      title: localizeTemplateText('Linked metadata package', 'حزمة بيانات وصفية مرتبطة', languageMode),
      note: `${neutralizeServiceMentions(job.title, languageMode)} (${job.jobId})`,
    })),
  ];

  if (service5) {
    references.push({
      title: localizeTemplateText('Procedural 3D deliverables', 'مخرجات النمذجة ثلاثية الأبعاد', languageMode),
      note: localizeTemplateText(
        'Interactive viewer and render outputs were incorporated into the media and digital portfolio layers.',
        'تم إدراج المشاهد التفاعلية ومخرجات الرندرة ضمن طبقات الوسائط والمحفظة الرقمية.',
        languageMode,
      ),
    });
  }

  return {
    title: labelForLanguage('Comprehensive Project Dossier', 'الوثيقة التوثيقية الشاملة للمشروع', languageMode),
    subtitle: context.brand.projectName,
    executiveSummary: localizeTemplateText(
      `${context.brand.projectName} consolidates ${contentModel.counts.totalAssets} indexed assets into a professional communication package that includes a comprehensive dossier, building-level documents, media-ready outputs, a digital portfolio, and delivery manifests.`,
      `يوحّد ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من الأصول المفهرسة ضمن حزمة تواصل مهنية تشمل وثيقة شاملة للمشروع، ووثائق على مستوى المباني، ومخرجات إعلامية جاهزة، ومحفظة رقمية، وملفات تسليم منظمة.`,
      languageMode,
    ),
    methodology: localizeTemplateText(
      'The documentation and media pipeline collects linked project outputs, classifies files by building, district, type, and usage, applies the selected project identity, and generates structured exports for print, presentation, and digital delivery.',
      'تجمع منظومة التوثيق والإخراج الإعلامي مخرجات المشروع المرتبطة، وتُصنِّف الملفات حسب المبنى والنطاق والنوع والاستخدام، وتطبق الهوية المختارة للمشروع، ثم تولد مخرجات منظمة للطباعة والعرض والتسليم الرقمي.',
      languageMode,
    ),
    buildingRecords,
    sections,
    references,
    appendices: [
      localizeTemplateText('Asset register and output manifest', 'سجل الأصول وفهرس المخرجات', languageMode),
      localizeTemplateText('Packaging manifest and delivery README', 'بيانات الحزمة وملف تعليمات التسليم', languageMode),
      localizeTemplateText('Building document list', 'قائمة وثائق المباني', languageMode),
      localizeTemplateText('Digital portfolio index', 'فهرس المحفظة الرقمية', languageMode),
      localizeTemplateText('Media script and captions pack', 'حزمة النصوص الإعلامية والتعليقات', languageMode),
    ],
  };
}

// Refined dossier builders override the initial template-focused versions above.
function buildBuildingRecords(contentModel, linkedJobs, brand) {
  const entries = Object.entries(contentModel.byBuilding)
    .filter(([name]) => normalizeText(name) && name !== 'Project-wide');

  if (!entries.length) {
    return [{
      name: normalizeText(brand.projectName, 'General Building File'),
      assets: contentModel.assets.slice(0, 24),
      summary: localizeTemplateText(
        'No distinct building names were submitted, so one project-wide building record will be assembled from the available linked material. This document should be read as a general chapter for the full project rather than a fully separated building schedule.',
        'لم ترد أسماء مبان مستقلة ضمن البيانات المدخلة، لذلك سيجري تجميع سجل مبنى عام على مستوى المشروع من المواد المرتبطة المتاحة. ويجب قراءة هذا الملف بوصفه فصلا عاما للمشروع الكامل لا جدولا مفصلا لمبان منفصلة.',
        brand.languageMode,
      ),
    }];
  }

  return entries.map(([name, assets]) => ({
    name,
    assets,
    summary: describeBuildingRecord(name, assets, brand),
  }));
}

function buildDossierModel(context, linkedJobs, contentModel) {
  const languageMode = context.brand.languageMode;
  const buildingRecords = buildBuildingRecords(contentModel, linkedJobs, context.brand);
  const service3 = findFirstJob(linkedJobs, 3);
  const service4 = findFirstJob(linkedJobs, 4);
  const service5 = findFirstJob(linkedJobs, 5);
  const totalJobs = linkedJobs.length;
  const coverage = buildCoverageModel(linkedJobs, contentModel);
  const typeSummary = Object.entries(contentModel.byType)
    .map(([type, count]) => `${localizedAssetType(type, languageMode)}: ${count}`)
    .join(', ');

  const coverageNarrative = [
    coverage.hasVisualReferences
      ? localizeTemplateText(
        `Visual references are available, with ${coverage.visualCount} image-based asset(s) supporting review, presentation, and comparison.`,
        `تتوفر مراجع بصرية، ويشمل ذلك ${coverage.visualCount} أصلا بصريا يدعم المراجعة والعرض والمقارنة.`,
        languageMode,
      )
      : localizeTemplateText(
        'No dedicated visual reference set was linked, so visual interpretation remains limited to the files packaged directly within this delivery.',
        'لم يتم ربط مجموعة مراجع بصرية مخصصة، لذلك يبقى التفسير البصري مقيدا بالملفات المضافة مباشرة داخل هذه الحزمة.',
        languageMode,
      ),
    coverage.hasUrbanAnalysis
      ? localizeTemplateText(
        `Urban and geographic material is present through ${coverage.mapCount} map or spatial dataset(s), allowing the dossier to anchor the project within its broader setting.`,
        `تتوفر مواد عمرانية وجغرافية من خلال ${coverage.mapCount} من الخرائط أو البيانات المكانية، بما يسمح بربط المشروع بسياقه الأوسع.`,
        languageMode,
      )
      : localizeTemplateText(
        'District-scale and geographic analysis was not explicitly linked, so the dossier records only the available site-level evidence and states that limitation transparently.',
        'لم يتم ربط تحليل جغرافي أو عمراني على مستوى النطاق بشكل صريح، لذلك تسجل الوثيقة الأدلة المتاحة على مستوى الموقع فقط مع بيان هذا القيد بوضوح.',
        languageMode,
      ),
    coverage.hasStructuredReporting
      ? localizeTemplateText(
        `Narrative and analytical reporting is available through ${coverage.reportCount} report file(s), enabling stronger methodological and reference framing.`,
        `يتوفر سرد وتحليل من خلال ${coverage.reportCount} ملف تقرير، ما يدعم صياغة منهجية ومرجعية أوضح.`,
        languageMode,
      )
      : localizeTemplateText(
        'Structured narrative reporting was not linked in full, therefore the dossier avoids overstating completeness and limits interpretation to the indexed evidence.',
        'لم يتم ربط تقارير سردية منظمة بصورة كاملة، ولذلك تتجنب الوثيقة المبالغة في اكتمال المشروع وتحصر التفسير في الأدلة المفهرسة المتاحة.',
        languageMode,
      ),
    coverage.hasThreeDimensionalOutputs
      ? localizeTemplateText(
        `Three-dimensional and interactive content is available through ${coverage.modelCount} model file(s) and ${coverage.interactiveCount} interactive output(s), supporting presentation and design communication.`,
        `تتوفر مواد ثلاثية الأبعاد وتفاعلية من خلال ${coverage.modelCount} ملف نموذج و${coverage.interactiveCount} مخرجا تفاعليا، بما يدعم العرض والتواصل التصميمي.`,
        languageMode,
      )
      : localizeTemplateText(
        'No linked three-dimensional package was detected, so the dossier remains focused on documentation and indexed deliverables rather than immersive presentation material.',
        'لم يتم رصد حزمة ثلاثية الأبعاد مرتبطة، لذلك تظل الوثيقة مركزة على التوثيق والمخرجات المفهرسة بدلا من المواد الغامرة الخاصة بالعرض.',
        languageMode,
      ),
  ].join('\n\n');

  const sections = [
    {
      id: 'project_overview',
      title: labelForLanguage('Project Overview', 'نظرة عامة على المشروع', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} was prepared for ${context.brand.implementingBody} as a final documentation dossier dated ${context.brand.preparationDate}. The package brings together ${contentModel.counts.totalAssets} indexed asset(s) from ${totalJobs} linked source package(s), while preserving the submitted project identity exactly as entered.`,
        `أُعد ${context.brand.projectName} لصالح ${context.brand.implementingBody} بوصفه وثيقة توثيق نهائية بتاريخ ${context.brand.preparationDate}. وتجمع الحزمة ${contentModel.counts.totalAssets} أصلا مفهرسا من ${totalJobs} حزمة مصدر مرتبطة، مع الحفاظ على هوية المشروع المدخلة كما وردت تماما.`,
        languageMode,
      ),
    },
    {
      id: 'documentation_scope',
      title: labelForLanguage('Documentation Scope and Evidence Base', 'نطاق التوثيق وقاعدة الأدلة', languageMode),
      body: coverageNarrative,
    },
    {
      id: 'historical_context',
      title: labelForLanguage('Historical and Geographic Context', 'السياق التاريخي والجغرافي', languageMode),
      body: service3
        ? localizeTemplateText(
          `${normalizeText(service3.metadata?.districtName, 'The project area')} in ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'the referenced location')} is documented through linked district-scale analysis, spatial datasets, and contextual mapping. These materials allow the dossier to position the project within its urban setting rather than describing the property in isolation.\n\nWhere district metadata is partial, the dossier keeps the interpretation conservative and relies only on verifiable linked evidence.`,
          `يوثق ${normalizeText(service3.metadata?.districtName, 'منطقة المشروع')} في ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'الموقع المرجعي')} من خلال تحليل مرتبط على مستوى النطاق وبيانات مكانية وخرائط سياقية. وتتيح هذه المواد وضع المشروع داخل إطاره العمراني بدلا من وصفه بمعزل عن محيطه.\n\nوعند جزئية بيانات النطاق أو عدم اكتمالها، تحافظ الوثيقة على صياغة متحفظة وتستند فقط إلى الأدلة المرتبطة القابلة للتحقق.`,
          languageMode,
        )
        : localizeTemplateText(
          'No linked district-scale context package was provided. Accordingly, this dossier records the project location and the boundaries of the available evidence without claiming a complete historical or geographic interpretation.\n\nAdditional contextual analysis can be incorporated later when verified urban or historical reference material is linked.',
          'لم يتم توفير حزمة سياق مرتبطة على مستوى النطاق. وبناء على ذلك، تكتفي هذه الوثيقة بتسجيل موقع المشروع وحدود الأدلة المتاحة دون الادعاء بوجود تفسير تاريخي أو جغرافي مكتمل.\n\nويمكن لاحقا دمج تحليل سياقي إضافي عند ربط مواد عمرانية أو تاريخية موثقة.',
          languageMode,
        ),
    },
    {
      id: 'building_chapters',
      title: labelForLanguage('Building Documentation Sections', 'أقسام توثيق المباني', languageMode),
      body: localizeTemplateText(
        `Building-level documentation has been prepared for ${buildingRecords.length} building group(s). Each section consolidates the evidence currently available for that building and avoids assuming documentation depth that was not actually linked.\n\nThe emphasis is on producing readable final documentation chapters rather than an asset index alone.`,
        `أُعد توثيق على مستوى المباني لعدد ${buildingRecords.length} مجموعة مبان. ويجمع كل قسم الأدلة المتاحة فعليا لذلك المبنى دون افتراض عمق توثيقي لم يتم ربطه بالفعل.\n\nوينصب التركيز هنا على إنتاج فصول توثيق نهائية قابلة للقراءة لا مجرد فهرس للأصول.`,
        languageMode,
      ),
    },
    {
      id: 'urban_analysis',
      title: labelForLanguage('Urban Fabric and Spatial Reading', 'تحليل النسيج العمراني والقراءة المكانية', languageMode),
      body: service3
        ? localizeTemplateText(
          `The linked spatial set includes plans, geospatial datasets, analytical mapping, and interactive material. These outputs strengthen the dossier by connecting the project to access patterns, district structure, and surrounding urban relationships.\n\nAvailable district notes: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          `تتضمن المجموعة المكانية المرتبطة مخططات وبيانات جغرافية مكانية وخرائط تحليلية ومواد تفاعلية. وتعزز هذه المخرجات الوثيقة من خلال ربط المشروع بأنماط الوصول وبنية النطاق والعلاقات العمرانية المحيطة.\n\nالملاحظات المتاحة عن النطاق: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          languageMode,
        )
        : localizeTemplateText(
          'Urban analysis material was not linked. This section therefore records the gap explicitly and keeps the final dossier limited to building-level and project-level evidence that is actually available.',
          'لم يتم ربط مواد تحليل عمراني. ولذلك يسجل هذا القسم الفجوة بصورة صريحة ويقصر الوثيقة النهائية على الأدلة المتاحة فعليا على مستوى المبنى والمشروع.',
          languageMode,
        ),
    },
    {
      id: 'standards_compliance',
      title: labelForLanguage('Standards and Compliance', 'المعايير والامتثال', languageMode),
      body: service4
        ? localizeTemplateText(
          'Linked analytical reporting supports this dossier as reference evidence for standards, methodology, and review requirements. The section is framed as a documentation aid and does not claim regulatory closure unless such closure is explicitly evidenced in the linked material.',
          'تدعم التقارير التحليلية المرتبطة هذه الوثيقة بوصفها أدلة مرجعية تتصل بالمعايير والمنهجية ومتطلبات المراجعة. ويعرض هذا القسم باعتباره أداة توثيقية مساندة ولا يدعي الحسم التنظيمي إلا إذا كان ذلك مثبتا صراحة في المواد المرتبطة.',
          languageMode,
        )
        : localizeTemplateText(
          'No dedicated compliance-oriented report was linked. The dossier therefore limits this chapter to documentation notes, reference placeholders, and a clear statement that additional review material would be required for any formal compliance claim.',
          'لم يتم ربط تقرير مخصص للامتثال. لذلك يقتصر هذا الفصل على ملاحظات توثيقية ومواضع مرجعية وبيان واضح بأن أي ادعاء رسمي بالامتثال يحتاج إلى مواد مراجعة إضافية.',
          languageMode,
        ),
    },
    {
      id: 'implementation_notes',
      title: labelForLanguage('Implementation Notes', 'ملاحظات التنفيذ', languageMode),
      body: localizeTemplateText(
        `The final package has been arranged for formal review and downstream use across print, presentation, and digital delivery. Available material has been separated into dossier files, building records, media assets, and structured manifests so the package can be navigated without losing the relationship to its source evidence.\n\nCurrent file-type coverage: ${typeSummary}.`,
        `رُتبت الحزمة النهائية لتناسب المراجعة الرسمية والاستخدام اللاحق عبر الطباعة والعرض والتسليم الرقمي. وفصلت المواد المتاحة إلى ملفات وثيقة رئيسية وسجلات مبان ومواد إعلامية وفهارس منظمة حتى يسهل التنقل داخل الحزمة من دون فقدان الصلة بأدلتها المرجعية.\n\nويشمل نطاق أنواع الملفات الحالية: ${typeSummary}.`,
        languageMode,
      ),
    },
    {
      id: 'conclusion',
      title: labelForLanguage('Conclusion', 'الخاتمة', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} is presented here as a polished documentation deliverable built from real linked content, not as a claim of completeness beyond the evidence supplied. Where source packages were missing, the dossier states that limitation directly; where evidence was available, it has been organized into a coherent final record fit for review and presentation.`,
        `يقدم ${context.brand.projectName} هنا بوصفه مخرجا توثيقيا مصقولا مبنيا على محتوى مرتبط فعليا، لا باعتباره ادعاء باكتمال يتجاوز الأدلة المقدمة. وحيث غابت بعض الحزم المرجعية، تذكر الوثيقة هذا القيد مباشرة؛ وحيث توفرت الأدلة، فقد نظمت في سجل نهائي متماسك صالح للمراجعة والعرض.`,
        languageMode,
      ),
    },
  ];

  const references = linkedJobs.map(job => ({
    title: localizeTemplateText('Linked metadata package', 'حزمة بيانات وصفية مرتبطة', languageMode),
    note: `${neutralizeServiceMentions(job.title, languageMode)} (${job.jobId})`,
  }));

  if (service5) {
    references.push({
      title: localizeTemplateText('Three-dimensional deliverables', 'مخرجات ثلاثية الأبعاد', languageMode),
      note: localizeTemplateText(
        'Interactive viewer and rendered visual outputs were incorporated where available.',
        'أدرجت المشاهد التفاعلية والمخرجات المرئية المعالجة حيثما توفرت.',
        languageMode,
      ),
    });
  }

  return {
    title: labelForLanguage('Comprehensive Project Dossier', 'الوثيقة التوثيقية الشاملة للمشروع', languageMode),
    subtitle: context.brand.projectName,
    executiveSummary: localizeTemplateText(
      `${context.brand.projectName} consolidates ${contentModel.counts.totalAssets} indexed asset(s) into a polished final documentation package centered on a comprehensive dossier, building-level records, and presentation-ready outputs. The narrative is based on real linked evidence only, with missing source areas identified clearly rather than inferred.`,
      `يوحد ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من الأصول المفهرسة ضمن حزمة توثيق نهائية مصقولة تتمحور حول وثيقة شاملة وسجلات على مستوى المباني ومخرجات جاهزة للعرض. ويستند السرد إلى الأدلة المرتبطة الفعلية فقط، مع بيان مجالات النقص بوضوح بدلا من افتراضها.`,
      languageMode,
    ),
    methodology: localizeTemplateText(
      'The export pipeline assembles linked project materials, classifies them by building, district, source, type, and usage, then renders a unified dossier and companion outputs using language-aware formatting rules. Arabic rendering, RTL direction, and mixed-language handling are treated as export requirements rather than optional styling.',
      'تجمع منظومة التصدير مواد المشروع المرتبطة وتصنفها حسب المبنى والنطاق والمصدر والنوع والاستخدام، ثم تنتج وثيقة موحدة ومخرجات مساندة باستخدام قواعد تنسيق واعية باللغة. وتعامل سلامة العربية واتجاه اليمين إلى اليسار ومعالجة النصوص المختلطة على أنها متطلبات تصدير أساسية لا مجرد تحسينات شكلية.',
      languageMode,
    ),
    coverage,
    buildingRecords,
    sections,
    references,
    appendices: [
      localizeTemplateText('Asset register and generated output manifest', 'سجل الأصول وفهرس المخرجات الناتجة', languageMode),
      localizeTemplateText('Packaging manifest and delivery guidance', 'بيانات الحزمة وإرشادات التسليم', languageMode),
      localizeTemplateText('Building record list', 'قائمة سجلات المباني', languageMode),
      localizeTemplateText('Digital portfolio index', 'فهرس المحفظة الرقمية', languageMode),
      localizeTemplateText('Media script and caption set', 'حزمة النصوص الإعلامية والتعليقات', languageMode),
    ],
  };
}

function buildReadmeText(context, dossier, outputFiles, packageRootName) {
  const lines = [
    `${context.brand.projectName}`,
    `${SERVICE_06_NAME}`,
    '',
    localizeTemplateText(`Package root: ${packageRootName}`, `جذر الحزمة: ${packageRootName}`, context.brand.languageMode),
    localizeTemplateText(`Preparation date: ${context.brand.preparationDate}`, `تاريخ الإعداد: ${context.brand.preparationDate}`, context.brand.languageMode),
    localizeTemplateText(`Implementing body: ${context.brand.implementingBody}`, `الجهة المنفذة: ${context.brand.implementingBody}`, context.brand.languageMode),
    localizeTemplateText(`Consultant / researcher team: ${context.brand.consultantTeam}`, `الفريق الاستشاري / البحثي: ${context.brand.consultantTeam}`, context.brand.languageMode),
    localizeTemplateText(
      `Language mode: ${localizedLanguageMode(context.brand.languageMode, 'english')}`,
      `لغة الإخراج: ${localizedLanguageMode(context.brand.languageMode, 'arabic')}`,
      context.brand.languageMode,
    ),
    '',
    localizeTemplateText('Included deliverables:', 'المخرجات المضمنة:', context.brand.languageMode),
    ...outputFiles.map(file => `- ${file.label}: ${file.relativePath}`),
    '',
    localizeTemplateText('Folder notes:', 'ملاحظات المجلدات:', context.brand.languageMode),
    localizeTemplateText('- 01_Images: restored images, visualizations, and render-derived stills', '- 01_Images: صور ترميمية ولقطات تصور بصري وصور مشتقة من الرندرة', context.brand.languageMode),
    localizeTemplateText('- 02_Plans: floor plans, urban plans, vector drawings, and printable sheets', '- 02_Plans: مخططات طوابق ومخططات عمرانية ورسومات متجهية ولوحات قابلة للطباعة', context.brand.languageMode),
    localizeTemplateText('- 03_3D_Models: print-ready and viewing-ready model exports', '- 03_3D_Models: مخرجات نماذج ثلاثية الأبعاد جاهزة للعرض والطباعة', context.brand.languageMode),
    localizeTemplateText('- 04_Reports: narrative reports, spreadsheets, metadata, and documentation tables', '- 04_Reports: تقارير سردية وجداول بيانات وبيانات وصفية وجداول توثيقية', context.brand.languageMode),
    localizeTemplateText('- 05_Presentations: presentation decks and slide-ready summaries', '- 05_Presentations: عروض تقديمية وملخصات جاهزة للشرائح', context.brand.languageMode),
    localizeTemplateText('- 06_Dossier: comprehensive dossier and building-level documentation', '- 06_Dossier: الوثيقة الشاملة وتوثيق المباني', context.brand.languageMode),
    localizeTemplateText('- 07_Digital_Portfolio: standalone HTML delivery and portfolio assets', '- 07_Digital_Portfolio: موقع HTML مستقل وأصول المحفظة الرقمية', context.brand.languageMode),
    localizeTemplateText('- 08_Media: infographic and promotional media support files', '- 08_Media: ملفات الإنفوجرافيك والمواد الإعلامية المساندة', context.brand.languageMode),
    '',
    localizeTemplateText('Usage guidance:', 'إرشادات الاستخدام:', context.brand.languageMode),
    localizeTemplateText('- Open PDF files for print-ready review.', '- افتح ملفات PDF للمراجعة والطباعة.', context.brand.languageMode),
    localizeTemplateText('- Edit DOCX files when narrative customization is needed.', '- حرر ملفات DOCX عند الحاجة إلى تخصيص السرد أو التنسيق.', context.brand.languageMode),
    localizeTemplateText('- Open PPTX files for decision-maker presentations.', '- افتح ملفات PPTX للعروض الموجهة لأصحاب القرار.', context.brand.languageMode),
    localizeTemplateText('- Open 07_Digital_Portfolio/HTML_Website/index.html in a browser for the portfolio view.', '- افتح 07_Digital_Portfolio/HTML_Website/index.html في المتصفح لعرض المحفظة الرقمية.', context.brand.languageMode),
    localizeTemplateText('- Use the Excel manifest to review specifications and generated outputs.', '- استخدم ملف Excel لمراجعة المواصفات والمخرجات الناتجة.', context.brand.languageMode),
  ];

  return lines.join('\n');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name);
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(dataBuf), 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, dataBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc32(dataBuf), 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function buildPackageRelativePath(asset) {
  const ext = `.${String(asset.ext || '').toLowerCase()}`;
  const name = path.basename(asset.name);
  const lowerName = name.toLowerCase();

  if (asset.service === 1) {
    if (asset.type === 'image') return lowerName.includes('before_after') ? path.join('01_Images', 'Comparisons', name) : path.join('01_Images', 'Restored', name);
    if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
  }

  if (asset.service === 2) {
    if (asset.type === 'image') return path.join('01_Images', 'Visualizations', name);
    if (ext === '.dxf') return path.join('02_Plans', 'AutoCAD_DWG', name);
    if (ext === '.svg' || ext === '.ai') return path.join('02_Plans', 'AI', name);
    if (ext === '.pdf') return path.join('02_Plans', 'PDF', name);
    if (asset.type === 'presentation') return path.join('05_Presentations', 'PPT', name);
    if (asset.type === 'spreadsheet') return path.join('04_Reports', 'Data_Excel', name);
    if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
  }

  if (asset.service === 3) {
    if (asset.type === 'image') return path.join('01_Images', 'Visualizations', name);
    if (ext === '.dxf') return path.join('02_Plans', 'AutoCAD_DWG', name);
    if (ext === '.svg' || ext === '.ai') return path.join('02_Plans', 'AI', name);
    if (ext === '.pdf') return path.join('02_Plans', 'PDF', name);
    if (asset.type === 'spreadsheet') return path.join('04_Reports', 'Data_Excel', name);
    if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
    if (asset.type === 'html') return path.join('07_Digital_Portfolio', 'HTML_Website', 'interactive_maps', name);
    if (asset.type === 'map-data') return path.join('02_Plans', 'Urban_Maps', name);
  }

  if (asset.service === 4) {
    if (asset.type === 'presentation') return path.join('05_Presentations', 'PPT', name);
    if (asset.type === 'spreadsheet') return path.join('04_Reports', 'Data_Excel', name);
    if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
    if (asset.type === 'metadata') return path.join('04_Reports', 'Metadata', name);
  }

  if (asset.service === 5) {
    if (asset.type === 'model') {
      if (ext === '.stl') return path.join('03_3D_Models', 'Print_Ready_STL', name);
      if (ext === '.glb' || ext === '.gltf' || ext === '.fbx') return path.join('03_3D_Models', 'Viewing_GLB_FBX', name);
      return path.join('03_3D_Models', 'Master_Plan', name);
    }
    if (asset.type === 'image') return path.join('01_Images', '3D_Renders', name);
    if (asset.type === 'html') return path.join('07_Digital_Portfolio', 'HTML_Website', 'interactive_models', name);
    if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
    if (asset.type === 'spreadsheet') return path.join('04_Reports', 'Data_Excel', name);
  }

  if (asset.type === 'presentation') return path.join('05_Presentations', 'PPT', name);
  if (asset.type === 'report') return path.join('04_Reports', ext === '.pdf' ? 'Academic_Reports_PDF' : 'Academic_Reports_Word', name);
  if (asset.type === 'spreadsheet' || asset.type === 'metadata') return path.join('04_Reports', 'Data_Excel', name);
  if (asset.type === 'model') return path.join('03_3D_Models', 'Master_Plan', name);
  if (asset.type === 'html') return path.join('07_Digital_Portfolio', 'HTML_Website', 'supporting', name);
  if (asset.type === 'image') return path.join('01_Images', 'Visualizations', name);
  if (asset.type === 'drawing') return path.join('02_Plans', 'AI', name);
  if (asset.type === 'map-data') return path.join('02_Plans', 'Urban_Maps', name);
  return path.join('04_Reports', 'Metadata', name);
}

function copyAssetsIntoPackage(packageRoot, contentModel, brand) {
  const copiedAssets = [];

  for (const asset of contentModel.assets) {
    if (!fs.existsSync(asset.path)) continue;
    const relativePath = buildPackageRelativePath(asset);
    const destination = uniqueDestinationPath(path.join(packageRoot, relativePath));
    ensureDir(path.dirname(destination));
    fs.copyFileSync(asset.path, destination);
    copiedAssets.push({
      ...asset,
      copiedPath: destination,
      relativePath: toWebPath(path.relative(packageRoot, destination)),
    });
  }

  for (const logo of brand.logos || []) {
    if (!fs.existsSync(logo.storedPath)) continue;
    const destination = uniqueDestinationPath(path.join(packageRoot, '00_Project_Metadata', 'Branding', 'Logos', path.basename(logo.originalName)));
    ensureDir(path.dirname(destination));
    fs.copyFileSync(logo.storedPath, destination);
    copiedAssets.push({
      id: `logo:${logo.originalName}`,
      sourceKind: 'logo',
      service: 0,
      serviceName: 'Brand Assets',
      jobId: null,
      title: brand.projectName,
      building: 'Project-wide',
      district: 'Project-wide',
      city: '',
      name: logo.originalName,
      path: logo.storedPath,
      ext: logo.ext,
      sizeKB: logo.sizeKB,
      type: 'image',
      usage: 'logo',
      copiedPath: destination,
      relativePath: toWebPath(path.relative(packageRoot, destination)),
    });
  }

  return copiedAssets;
}

function firstLogoFromAssets(assets = []) {
  return assets.find(asset => asset.usage === 'logo' && asset.copiedPath) || null;
}

async function resolvePdfRenderableImagePath(filePath, outDir) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const ext = fileExt(filePath);
  if (ext !== '.svg') return filePath;

  const rasterPath = uniqueDestinationPath(path.join(outDir, `${path.basename(filePath, ext)}_pdf.png`));
  await sharp(filePath).png().toFile(rasterPath);
  return rasterPath;
}

async function resolveRenderableImagePath(filePath, outDir, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const ext = fileExt(filePath);
  const forcePng = Boolean(options.forcePng);
  if (!forcePng && ext !== '.svg' && ext !== '.webp') return filePath;

  const suffix = normalizeText(options.suffix, 'render');
  const rasterPath = uniqueDestinationPath(path.join(outDir, `${path.basename(filePath, ext)}_${suffix}.png`));
  await sharp(filePath).png().toFile(rasterPath);
  return rasterPath;
}

async function getContainedImageDimensions(filePath, maxWidth, maxHeight) {
  const fallback = {
    width: Math.round(maxWidth),
    height: Math.round(Math.min(maxHeight, maxWidth * 0.45)),
  };

  if (!filePath || !fs.existsSync(filePath)) return fallback;

  try {
    const meta = await sharp(filePath).metadata();
    const width = Number(meta.width) || fallback.width;
    const height = Number(meta.height) || fallback.height;
    if (!width || !height) return fallback;
    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  } catch (error) {
    return fallback;
  }
}

async function prepareLogoPlacement(filePath, outDir, options = {}) {
  const renderPath = await resolveRenderableImagePath(filePath, outDir, {
    forcePng: Boolean(options.forcePng),
    suffix: options.suffix || 'logo',
  });
  if (!renderPath) return null;

  const maxWidth = options.maxWidth || 170;
  const maxHeight = options.maxHeight || 80;
  const dimensions = await getContainedImageDimensions(renderPath, maxWidth, maxHeight);
  return {
    path: renderPath,
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function buildWordDossier(dossier, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const rtlLike = context.brand.languageMode === 'arabic' || context.brand.languageMode === 'bilingual';
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const children = [
    new Paragraph({
      text: dossier.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      text: dossier.subtitle,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: `${context.brand.implementingBody} | ${context.brand.preparationDate}`, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: `${labelForLanguage('Consultant Team', 'الفريق الاستشاري', context.brand.languageMode)}: ${context.brand.consultantTeam}`, alignment: paragraphAlign }),
    new Paragraph({ text: `${labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
    new Paragraph({ text: dossier.executiveSummary, alignment: paragraphAlign }),
    new Paragraph({ text: `${labelForLanguage('Methodology', 'المنهجية', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
    new Paragraph({ text: dossier.methodology, alignment: paragraphAlign }),
    new Paragraph({ text: `${labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
  ];

  dossier.sections.forEach((section, index) => {
    children.push(new Paragraph({ text: `${index + 1}. ${section.title}`, alignment: paragraphAlign }));
  });

  dossier.sections.forEach(section => {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
    children.push(new Paragraph({ text: section.body, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  dossier.buildingRecords.forEach((building, index) => {
    children.push(new Paragraph({ text: `${index + 1}. ${building.name}`, heading: HeadingLevel.HEADING_2, alignment: paragraphAlign }));
    children.push(new Paragraph({ text: building.summary, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('References', 'المراجع', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  dossier.references.forEach(ref => {
    children.push(new Paragraph({ text: `${ref.title} - ${ref.note}`, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Appendices', 'الملاحق', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  dossier.appendices.forEach(item => {
    children.push(new Paragraph({ text: item, alignment: paragraphAlign }));
  });

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

async function buildPdfDossier(dossier, context, images, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const rtlLike = context.brand.languageMode === 'arabic' || context.brand.languageMode === 'bilingual';
    const align = rtlLike ? 'right' : 'left';
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 20;
    const ensureSpace = (minHeight = 48) => {
      if (doc.y + minHeight > pageBottom()) doc.addPage();
    };

    (async () => {
      if (doc.outline && doc.outline.addItem) {
        doc.outline.addItem(dossier.title);
      }

      const logoPath = await resolvePdfRenderableImagePath(context.brand.logoPath, path.dirname(outPath));
      if (logoPath) {
        try {
          const logoWidth = 170;
          const logoHeight = 80;
          const logoX = (doc.page.width - logoWidth) / 2;
          const logoY = doc.y;
          doc.image(logoPath, logoX, logoY, { fit: [logoWidth, logoHeight], align: 'center' });
          doc.y = logoY + logoHeight + 14;
        } catch (error) {
          // Ignore broken logos and continue.
        }
      }

      setPdfFont(doc, true).fontSize(24).fillColor(context.brand.primaryColor).text(formatPdfText(dossier.title, context.brand.languageMode), { align: 'center' });
      doc.moveDown(0.3);
      setPdfFont(doc, false).fontSize(14).fillColor('#334155').text(formatPdfText(dossier.subtitle, context.brand.languageMode), { align: 'center' });
      doc.moveDown(0.2);
      setPdfFont(doc, false).fontSize(10).fillColor('#475569').text(formatPdfText(`${context.brand.implementingBody} | ${context.brand.preparationDate}`, context.brand.languageMode), { align: 'center' });
      doc.moveDown(1);

      if (images[0] && fs.existsSync(images[0].path)) {
        try {
          doc.image(images[0].path, { fit: [515, 220], align: 'center' });
          doc.moveDown(0.8);
        } catch (error) {
          // Ignore broken images and continue.
        }
      }

      ensureSpace(72);
      setPdfFont(doc, true).fontSize(14).fillColor('#0f172a').text(formatPdfText(labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode), context.brand.languageMode), { align });
      doc.moveDown(0.2);
      setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(formatPdfText(dossier.executiveSummary, context.brand.languageMode), { align: rtlLike ? 'right' : 'justify' });
      doc.moveDown(0.7);

      ensureSpace(72);
      setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(formatPdfText(labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode), context.brand.languageMode), { align });
      dossier.sections.forEach((section, index) => {
        ensureSpace(22);
        setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(formatPdfText(`${index + 1}. ${section.title}`, context.brand.languageMode), { indent: 12, align });
      });
      doc.moveDown(0.8);

      for (const section of dossier.sections) {
        ensureSpace(64);
        setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(formatPdfText(section.title, context.brand.languageMode), { align });
        doc.moveDown(0.2);
        setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(formatPdfText(section.body, context.brand.languageMode), { align: rtlLike ? 'right' : 'justify' });
        doc.moveDown(0.8);
      }

      if (dossier.buildingRecords.length) {
        ensureSpace(64);
        setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(formatPdfText(labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode), context.brand.languageMode), { align });
        doc.moveDown(0.3);
        dossier.buildingRecords.forEach((building, index) => {
          ensureSpace(46);
          setPdfFont(doc, true).fontSize(11).fillColor('#0f172a').text(formatPdfText(`${index + 1}. ${building.name}`, context.brand.languageMode), { align });
          setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(formatPdfText(building.summary, context.brand.languageMode), { align: rtlLike ? 'right' : 'justify' });
          doc.moveDown(0.45);
        });
      }

      if (dossier.references.length) {
        ensureSpace(64);
        setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(formatPdfText(labelForLanguage('References', 'المراجع', context.brand.languageMode), context.brand.languageMode), { align });
        doc.moveDown(0.25);
        dossier.references.forEach(ref => {
          ensureSpace(24);
          setPdfFont(doc, false).fontSize(9).fillColor('#334155').text(formatPdfText(`${ref.title} - ${ref.note}`, context.brand.languageMode), { align });
        });
      }

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(i);
        setPdfFont(doc, false).fontSize(8).fillColor('#64748b').text(
          formatPdfText(labelForLanguage(`Page ${i + 1} of ${range.count}`, `الصفحة ${i + 1} من ${range.count}`, context.brand.languageMode), context.brand.languageMode),
          40,
          doc.page.height - 26,
          { align: 'center', width: doc.page.width - 80 },
        );
      }

      doc.end();
    })().catch(reject);

    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildWordBuildingDocument(building, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const rtlLike = context.brand.languageMode === 'arabic' || context.brand.languageMode === 'bilingual';
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const groupedTypes = building.assets.reduce((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});

  const children = [
    new Paragraph({ text: building.name, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: building.summary, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: labelForLanguage('Asset Summary', 'ملخص الأصول', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
  ];

  Object.entries(groupedTypes).forEach(([type, count]) => {
    children.push(new Paragraph({ text: `${localizedAssetType(type, context.brand.languageMode)}: ${count}`, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Implementation Notes', 'ملاحظات التنفيذ', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  children.push(new Paragraph({
    text: localizeTemplateText(
      `This building file was prepared as part of ${context.brand.projectName}. Available evidence has been grouped for presentation, review, and downstream editing.`,
      `أُعد هذا الملف الخاص بالمبنى ضمن ${context.brand.projectName}. وقد جُمعت الأدلة المتاحة فيه لأغراض العرض والمراجعة والتحرير اللاحق.`,
      context.brand.languageMode,
    ),
    alignment: paragraphAlign,
  }));

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

async function buildPdfBuildingDocument(building, context, imagePath, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const rtlLike = context.brand.languageMode === 'arabic' || context.brand.languageMode === 'bilingual';
    const align = rtlLike ? 'right' : 'left';

    setPdfFont(doc, true).fontSize(22).fillColor(context.brand.primaryColor).text(formatPdfText(building.name, context.brand.languageMode), { align: 'center' });
    doc.moveDown(0.3);
    setPdfFont(doc, false).fontSize(10).fillColor('#475569').text(formatPdfText(context.brand.projectName, context.brand.languageMode), { align: 'center' });
    doc.moveDown(0.8);

    if (imagePath && fs.existsSync(imagePath)) {
      try {
        doc.image(imagePath, { fit: [515, 230], align: 'center' });
        doc.moveDown(0.8);
      } catch (error) {
        // Non-fatal image issue.
      }
    }

    setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(formatPdfText(building.summary, context.brand.languageMode), { align: rtlLike ? 'right' : 'justify' });
    doc.moveDown(0.6);
    setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(formatPdfText(labelForLanguage('Available Content', 'المحتوى المتاح', context.brand.languageMode), context.brand.languageMode), { align });
    doc.moveDown(0.2);

    building.assets.slice(0, 20).forEach(asset => {
      setPdfFont(doc, false).fontSize(9).fillColor('#334155').text(
        formatPdfText(`- ${asset.name} (${localizedAssetType(asset.type, context.brand.languageMode)})`, context.brand.languageMode),
        { align },
      );
    });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSimplePptx(slides, reportTitle, outPath) {
  const slideEntries = [];
  const slideRelEntries = [];
  const imageEntries = [];
  const slideIdEntries = [];
  const presentationRelEntries = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];

  slides.forEach((slide, index) => {
    const slideNo = index + 1;
    const hasImage = slide.imagePath && fs.existsSync(slide.imagePath) && isWebReadyImage(fileExt(slide.imagePath));
    const mediaName = hasImage ? `slide${slideNo}${fileExt(slide.imagePath) || '.png'}` : '';

    slideIdEntries.push(`<p:sldId id="${255 + slideNo}" r:id="rId${slideNo + 1}"/>`);
    presentationRelEntries.push(`<Relationship Id="rId${slideNo + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`);

    const pictureXml = hasImage ? `
      <p:pic>
        <p:nvPicPr><p:cNvPr id="4" name="Picture ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="2400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>` : '';

    slideEntries.push({
      name: `ppt/slides/slide${slideNo}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="685800"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>${xmlEscape(slide.title)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="${hasImage ? '3940800' : '1371600'}"/><a:ext cx="8229600" cy="${hasImage ? '1000000' : '2500000'}"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${xmlEscape(slide.subtitle)}</a:t></a:r></a:p></p:txBody>
      </p:sp>${pictureXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    });

    if (hasImage) {
      imageEntries.push({ name: `ppt/media/${mediaName}`, data: fs.readFileSync(slide.imagePath) });
      slideRelEntries.push({
        name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>
</Relationships>`,
      });
    } else {
      slideRelEntries.push({
        name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
      });
    }
  });

  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slides.map((_, idx) => `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
    },
    {
      name: 'docProps/app.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codex</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips></Properties>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(reportTitle)}</dc:title><dc:creator>Codex</dc:creator><cp:lastModifiedBy>Codex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIdEntries.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presentationRelEntries.join('\n  ')}
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId${slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId${slides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/slideMasters/slideMaster1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>`,
    },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
    },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    },
    {
      name: 'ppt/theme/theme1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Service06"><a:themeElements><a:clrScheme name="Service06"><a:dk1><a:srgbClr val="1A3554"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0F172A"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="DFAF67"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="6366F1"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Service06"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Service06"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
    },
    {
      name: 'ppt/presProps.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    },
    {
      name: 'ppt/viewProps.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`,
    },
    {
      name: 'ppt/tableStyles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def=""/>`,
    },
    ...slideEntries,
    ...slideRelEntries,
    ...imageEntries,
  ];

  fs.writeFileSync(outPath, createStoredZip(entries));
}

async function buildExcelManifest(context, dossier, contentModel, deliverables, outPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_06_NAME;
  workbook.created = new Date();

  const languageMode = context.brand.languageMode;
  const summary = workbook.addWorksheet(labelForLanguage('Project Summary', 'ملخص المشروع', languageMode));
  summary.columns = [
    { header: labelForLanguage('Field', 'الحقل', languageMode), width: 28 },
    { header: labelForLanguage('Value', 'القيمة', languageMode), width: 70 },
  ];
  [
    [labelForLanguage('Project Name', 'اسم المشروع', languageMode), context.brand.projectName],
    [labelForLanguage('Implementing Body', 'الجهة المنفذة', languageMode), context.brand.implementingBody],
    [labelForLanguage('Preparation Date', 'تاريخ الإعداد', languageMode), context.brand.preparationDate],
    [labelForLanguage('Consultant Team', 'الفريق الاستشاري', languageMode), context.brand.consultantTeam],
    [labelForLanguage('Language Mode', 'لغة الإخراج', languageMode), localizedLanguageMode(context.brand.languageMode, languageMode)],
    [labelForLanguage('Assets Indexed', 'الأصول المفهرسة', languageMode), contentModel.counts.totalAssets],
    [labelForLanguage('Images', 'الصور', languageMode), contentModel.counts.images],
    [labelForLanguage('Reports', 'التقارير', languageMode), contentModel.counts.reports],
    [labelForLanguage('Models', 'النماذج', languageMode), contentModel.counts.models],
    [labelForLanguage('Presentations', 'العروض التقديمية', languageMode), contentModel.counts.presentations],
  ].forEach(row => summary.addRow(row));

  const assets = workbook.addWorksheet(labelForLanguage('Asset Register', 'سجل الأصول', languageMode));
  assets.columns = [
    { header: labelForLanguage('Source', 'المصدر', languageMode), width: 28 },
    { header: labelForLanguage('Building', 'المبنى', languageMode), width: 28 },
    { header: labelForLanguage('District', 'النطاق', languageMode), width: 28 },
    { header: labelForLanguage('File', 'الملف', languageMode), width: 42 },
    { header: labelForLanguage('Type', 'النوع', languageMode), width: 18 },
    { header: labelForLanguage('Usage', 'الاستخدام', languageMode), width: 24 },
    { header: labelForLanguage('Size KB', 'الحجم كيلوبايت', languageMode), width: 12 },
  ];
  contentModel.assets.forEach(asset => {
    assets.addRow([
      asset.sourceLabel,
      asset.building,
      asset.district,
      asset.name,
      localizedAssetType(asset.type, languageMode),
      asset.usage,
      asset.sizeKB,
    ]);
  });

  const outputs = workbook.addWorksheet(labelForLanguage('Generated Outputs', 'المخرجات الناتجة', languageMode));
  outputs.columns = [
    { header: labelForLanguage('Label', 'الاسم', languageMode), width: 34 },
    { header: labelForLanguage('Relative Path', 'المسار النسبي', languageMode), width: 60 },
    { header: labelForLanguage('Extension', 'الامتداد', languageMode), width: 14 },
  ];
  deliverables.forEach(file => outputs.addRow([file.label, file.relativePath, file.ext]));

  const buildings = workbook.addWorksheet(labelForLanguage('Buildings', 'المباني', languageMode));
  buildings.columns = [
    { header: labelForLanguage('Building', 'المبنى', languageMode), width: 34 },
    { header: labelForLanguage('Summary', 'الملخص', languageMode), width: 90 },
  ];
  dossier.buildingRecords.forEach(building => buildings.addRow([building.name, building.summary]));

  await workbook.xlsx.writeFile(outPath);
}

function buildInfographicSvg(context, contentModel, dossier) {
  const languageMode = context.brand.languageMode;
  const sourceBlocks = Object.entries(contentModel.bySource)
    .map(([name, count], index) => {
      const x = 80 + (index % 2) * 290;
      const y = 280 + Math.floor(index / 2) * 90;
      return `
  <rect x="${x}" y="${y}" width="250" height="64" rx="16" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" />
  <text x="${x + 18}" y="${y + 28}" font-size="18" font-family="Arial" fill="#f8fafc">${xmlEscape(name)}</text>
  <text x="${x + 18}" y="${y + 50}" font-size="26" font-family="Arial" font-weight="700" fill="${context.brand.accentColor}">${count}</text>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${context.brand.primaryColor}" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
  </defs>
  <rect width="1200" height="900" fill="url(#bg)" />
  <rect x="54" y="54" width="1092" height="792" rx="32" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" />
  <text x="84" y="122" font-size="28" font-family="Arial" font-weight="700" fill="#ffffff">${xmlEscape(context.brand.projectName)}</text>
  <text x="84" y="156" font-size="16" font-family="Arial" fill="#dbeafe">${xmlEscape(dossier.title)}</text>
  <text x="84" y="220" font-size="64" font-family="Arial" font-weight="700" fill="${context.brand.accentColor}">${contentModel.counts.totalAssets}</text>
  <text x="84" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Indexed project assets', 'أصول المشروع المفهرسة', languageMode))}</text>
  <text x="430" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#38bdf8">${dossier.buildingRecords.length}</text>
  <text x="430" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Building document groups', 'مجموعات وثائق المباني', languageMode))}</text>
  <text x="760" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#10b981">${contentModel.counts.html + contentModel.counts.presentations + contentModel.counts.models}</text>
  <text x="760" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Digital and presentation outputs', 'المخرجات الرقمية والعرضية', languageMode))}</text>
  ${sourceBlocks}
  <text x="84" y="740" font-size="18" font-family="Arial" fill="#f8fafc">${xmlEscape(labelForLanguage('Coverage', 'نطاق التغطية', languageMode))}</text>
  <text x="84" y="772" font-size="15" font-family="Arial" fill="#cbd5e1">${xmlEscape(dossier.executiveSummary)}</text>
</svg>`;
}

async function buildInfographics(context, contentModel, dossier, mediaDir) {
  const svgPath = path.join(mediaDir, 'project_infographic.svg');
  const pngPath = path.join(mediaDir, 'project_infographic.png');
  const pdfPath = path.join(mediaDir, 'project_infographic.pdf');
  const svg = buildInfographicSvg(context, contentModel, dossier);
  fs.writeFileSync(svgPath, svg);
  await sharp(Buffer.from(svg)).png().toFile(pngPath);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 18 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    doc.image(pngPath, { fit: [560, 800], align: 'center', valign: 'center' });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { svgPath, pngPath, pdfPath };
}

function buildPromoScript(context, dossier, contentModel) {
  return [
    localizeTemplateText(`Project: ${context.brand.projectName}`, `المشروع: ${context.brand.projectName}`, context.brand.languageMode),
    localizeTemplateText(`Style direction: ${context.project.brandingPreferences}`, `توجه الهوية: ${context.project.brandingPreferences}`, context.brand.languageMode),
    '',
    localizeTemplateText('Suggested short promo structure:', 'هيكل مقترح للمادة الترويجية القصيرة:', context.brand.languageMode),
    localizeTemplateText('1. Opening title card with project identity and implementing body.', '1. افتتاحية بعنوان المشروع والجهة المنفذة.', context.brand.languageMode),
    localizeTemplateText('2. Present the heritage context with restored visuals and key urban imagery.', '2. عرض السياق التراثي من خلال الصور المعالجة واللقطات العمرانية الأساسية.', context.brand.languageMode),
    localizeTemplateText('3. Highlight architectural visualizations, building plans, and analytical reports.', '3. إبراز التصورات المعمارية والمخططات وتقارير التحليل.', context.brand.languageMode),
    localizeTemplateText('4. Introduce 3D models, digital portfolio outputs, and implementation readiness.', '4. تقديم النماذج ثلاثية الأبعاد ومخرجات المحفظة الرقمية وجاهزية التنفيذ.', context.brand.languageMode),
    localizeTemplateText('5. Close with the dossier, delivery package, and project impact statement.', '5. اختتام المادة بالوثيقة الشاملة وحزمة التسليم وأثر المشروع.', context.brand.languageMode),
    '',
    localizeTemplateText(`Voiceover draft: ${dossier.executiveSummary}`, `مسودة التعليق الصوتي: ${dossier.executiveSummary}`, context.brand.languageMode),
    '',
    localizeTemplateText('Key figures:', 'الأرقام الرئيسية:', context.brand.languageMode),
    localizeTemplateText(`- Total indexed assets: ${contentModel.counts.totalAssets}`, `- إجمالي الأصول المفهرسة: ${contentModel.counts.totalAssets}`, context.brand.languageMode),
    localizeTemplateText(`- Building groups: ${dossier.buildingRecords.length}`, `- مجموعات المباني: ${dossier.buildingRecords.length}`, context.brand.languageMode),
    localizeTemplateText(`- Models: ${contentModel.counts.models}`, `- النماذج: ${contentModel.counts.models}`, context.brand.languageMode),
    localizeTemplateText(`- Reports: ${contentModel.counts.reports}`, `- التقارير: ${contentModel.counts.reports}`, context.brand.languageMode),
  ].join('\n');
}

function buildSocialCaptions(context, contentModel) {
  return [
    localizeTemplateText(
      `Caption 1: ${context.brand.projectName} now includes a complete documentation and media package integrating restored imagery, heritage analysis, plans, reports, and 3D assets.`,
      `التعليق 1: يتضمن ${context.brand.projectName} الآن حزمة توثيق وإخراج إعلامي متكاملة تجمع الصور المعالجة والتحليل التراثي والمخططات والتقارير والأصول ثلاثية الأبعاد.`,
      context.brand.languageMode,
    ),
    localizeTemplateText(
      `Caption 2: From restoration to presentation-ready delivery, the package organizes ${contentModel.counts.totalAssets} outputs into a professional handover format for review, publication, and digital sharing.`,
      `التعليق 2: من الترميم إلى التسليم الجاهز للعرض، تنظم الحزمة عدد ${contentModel.counts.totalAssets} من المخرجات ضمن صيغة مهنية للمراجعة والنشر والمشاركة الرقمية.`,
      context.brand.languageMode,
    ),
    localizeTemplateText(
      'Caption 3: The project portfolio supports dossier preparation, building-level documentation, interactive browsing, and media-ready communication assets.',
      'التعليق 3: تدعم محفظة المشروع إعداد الوثيقة الشاملة وتوثيق المباني والتصفح التفاعلي وأصول التواصل الجاهزة للإخراج الإعلامي.',
      context.brand.languageMode,
    ),
  ].join('\n\n');
}

function buildPortfolioHtml(context, dossier, copiedAssets, outPath) {
  const htmlDir = path.dirname(outPath);
  const heroImages = copiedAssets.filter(asset => asset.type === 'image').slice(0, 8);
  const mapFrames = copiedAssets.filter(asset => asset.usage === 'interactive-map').slice(0, 2);
  const modelFrames = copiedAssets.filter(asset => asset.usage === 'interactive-viewer').slice(0, 2);
  const logoAsset = copiedAssets.find(asset => asset.usage === 'logo' && asset.copiedPath) || null;
  const logoHtml = logoAsset
    ? `<div class="brand-logo"><img src="${xmlEscape(toWebPath(path.relative(htmlDir, logoAsset.copiedPath)))}" alt="${xmlEscape(context.brand.projectName)} logo"></div>`
    : '';
  const cards = Object.entries(dossier.buildingRecords.reduce((acc, building) => {
    acc[building.name] = building;
    return acc;
  }, {})).map(([name, building]) => {
    return `<article class="panel">
      <h3>${xmlEscape(name)}</h3>
      <p>${xmlEscape(building.summary)}</p>
    </article>`;
  }).join('\n');

  const gallery = heroImages.map(asset => {
    const rel = toWebPath(path.relative(htmlDir, asset.copiedPath));
    return `<figure class="shot"><img src="${xmlEscape(rel)}" alt="${xmlEscape(asset.name)}"><figcaption>${xmlEscape(asset.name)}</figcaption></figure>`;
  }).join('\n');

  const iframeBlocks = [...mapFrames, ...modelFrames].map(asset => {
    const rel = toWebPath(path.relative(htmlDir, asset.copiedPath));
    return `<iframe class="embed" src="${xmlEscape(rel)}" title="${xmlEscape(asset.name)}"></iframe>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="${context.brand.languageMode === 'arabic' ? 'ar' : 'en'}" dir="${context.brand.languageMode === 'arabic' ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${xmlEscape(context.brand.projectName)}</title>
  <style>
    :root{--bg:${context.brand.primaryColor};--card:#102033;--line:rgba(255,255,255,.12);--accent:${context.brand.accentColor};--text:#f8fafc;--muted:#cbd5e1}
    *{box-sizing:border-box} body{margin:0;font-family:${context.brand.typography},Arial,sans-serif;background:radial-gradient(circle at top left,${context.brand.primaryColor},#09111b 60%);color:var(--text)}
    .wrap{max-width:1180px;margin:0 auto;padding:40px 22px 60px}
    .hero{padding:38px;border:1px solid var(--line);border-radius:30px;background:rgba(255,255,255,.04);backdrop-filter:blur(10px)}
    .brand-logo{display:flex;justify-content:center;margin-bottom:18px}
    .brand-logo img{max-width:180px;max-height:88px;object-fit:contain;display:block}
    .eyebrow{display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(223,175,103,.14);color:var(--accent);font-weight:700;font-size:13px}
    h1{font-size:42px;line-height:1.1;margin:18px 0 10px}
    h2{margin-top:34px}
    p{color:var(--muted);line-height:1.7}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:26px}
    .panel{background:rgba(16,32,51,.88);border:1px solid var(--line);border-radius:22px;padding:20px}
    .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:18px}
    .shot{margin:0;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:18px;overflow:hidden}
    .shot img{width:100%;height:180px;object-fit:cover;display:block}
    .shot figcaption{padding:12px 14px;font-size:13px;color:var(--muted)}
    .embeds{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:20px}
    .embed{width:100%;min-height:380px;border:1px solid var(--line);border-radius:22px;background:#fff}
    @media (max-width:700px){h1{font-size:32px}.hero{padding:26px}}
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      ${logoHtml}
      <span class="eyebrow">${xmlEscape(SERVICE_06_NAME)}</span>
      <h1>${xmlEscape(context.brand.projectName)}</h1>
      <p>${xmlEscape(dossier.executiveSummary)}</p>
      <div class="grid">
        <div class="panel"><strong>${copiedAssets.length}</strong><p>${xmlEscape(labelForLanguage('Packaged files copied into the structured delivery folder.', 'ملفات منسوخة إلى مجلد التسليم المنظم.', context.brand.languageMode))}</p></div>
        <div class="panel"><strong>${dossier.buildingRecords.length}</strong><p>${xmlEscape(labelForLanguage('Building-level documentation groups.', 'مجموعات توثيق على مستوى المباني.', context.brand.languageMode))}</p></div>
        <div class="panel"><strong>${Object.keys(context.contentModel.bySource).length}</strong><p>${xmlEscape(labelForLanguage('Integrated source sets.', 'حزم مصادر مترابطة.', context.brand.languageMode))}</p></div>
      </div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode))}</h2>
      <div class="grid">${cards}</div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Visual Gallery', 'معرض بصري', context.brand.languageMode))}</h2>
      <div class="gallery">${gallery}</div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Interactive Embeds', 'محتوى تفاعلي', context.brand.languageMode))}</h2>
      <div class="embeds">${iframeBlocks || `<div class="panel"><p>${xmlEscape(labelForLanguage('No interactive HTML outputs were linked. The package still includes standalone files and structured navigation.', 'لم يتم ربط مخرجات HTML تفاعلية، ومع ذلك تتضمن الحزمة ملفات مستقلة وتنقلاً منظماً.', context.brand.languageMode))}</p></div>`}</div>
    </section>
  </div>
</body>
</html>`;

  fs.writeFileSync(outPath, html);
}

function createWordNarrativeParagraphs(text, context, options = {}) {
  return splitNarrativeParagraphs(text).map((paragraph, index) => createWordParagraph(paragraph, context, {
    ...options,
    spacing: index === 0
      ? (options.spacing || { line: 360, before: 80, after: 120 })
      : { line: 360, before: 40, after: 120 },
  }));
}

async function buildWordDossier(dossier, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const rtlLike = isRtlLanguage(context.brand.languageMode);
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const children = [];
  const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
    forcePng: true,
    suffix: 'word_logo',
    maxWidth: 170,
    maxHeight: 80,
  });

  if (logo && ImageRun && fs.existsSync(logo.path)) {
    try {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [
          new ImageRun({
            data: fs.readFileSync(logo.path),
            transformation: { width: logo.width, height: logo.height },
          }),
        ],
      }));
    } catch (error) {
      // Ignore logo rendering issues in Word.
    }
  }

  children.push(createWordParagraph(dossier.title, context, {
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    bold: true,
    size: 34,
    spacing: { after: 120 },
  }));
  children.push(createWordParagraph(dossier.subtitle, context, {
    alignment: AlignmentType.CENTER,
    size: 24,
    spacing: { after: 120 },
  }));
  children.push(createWordParagraph(
    `${labelForLanguage('Implementing Body', 'الجهة المنفذة', context.brand.languageMode)}: ${context.brand.implementingBody}`,
    context,
    { alignment: paragraphAlign },
  ));
  children.push(createWordParagraph(
    `${labelForLanguage('Preparation Date', 'تاريخ الإعداد', context.brand.languageMode)}: ${context.brand.preparationDate}`,
    context,
    { alignment: paragraphAlign },
  ));
  children.push(createWordParagraph(
    `${labelForLanguage('Consultant Team', 'الفريق الاستشاري', context.brand.languageMode)}: ${context.brand.consultantTeam}`,
    context,
    { alignment: paragraphAlign, spacing: { after: 240 } },
  ));
  children.push(createWordParagraph(labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
  }));
  children.push(...createWordNarrativeParagraphs(dossier.executiveSummary, context, { alignment: paragraphAlign }));
  children.push(createWordParagraph(labelForLanguage('Methodology', 'المنهجية', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
  }));
  children.push(...createWordNarrativeParagraphs(dossier.methodology, context, { alignment: paragraphAlign }));
  children.push(createWordParagraph(labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
  }));
  dossier.sections.forEach((section, index) => {
    children.push(createWordParagraph(`${index + 1}. ${section.title}`, context, {
      alignment: paragraphAlign,
      spacing: { line: 320, before: 40, after: 40 },
    }));
  });

  dossier.sections.forEach(section => {
    children.push(createWordParagraph(section.title, context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
      spacing: { before: 180, after: 80 },
    }));
    children.push(...createWordNarrativeParagraphs(section.body, context, { alignment: paragraphAlign }));
  });

  children.push(createWordParagraph(labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
    spacing: { before: 180, after: 80 },
  }));
  dossier.buildingRecords.forEach((building, index) => {
    children.push(createWordParagraph(`${index + 1}. ${building.name}`, context, {
      heading: HeadingLevel.HEADING_2,
      alignment: paragraphAlign,
      bold: true,
    }));
    children.push(...createWordNarrativeParagraphs(building.summary, context, { alignment: paragraphAlign }));
  });

  children.push(createWordParagraph(labelForLanguage('References', 'المراجع', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
    spacing: { before: 180, after: 80 },
  }));
  dossier.references.forEach(ref => {
    children.push(createWordParagraph(`${ref.title} - ${ref.note}`, context, {
      alignment: paragraphAlign,
      spacing: { line: 320, before: 20, after: 60 },
    }));
  });

  children.push(createWordParagraph(labelForLanguage('Appendices', 'الملاحق', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
    spacing: { before: 180, after: 80 },
  }));
  dossier.appendices.forEach(item => {
    children.push(createWordParagraph(`- ${item}`, context, {
      alignment: paragraphAlign,
      spacing: { line: 320, before: 20, after: 40 },
    }));
  });

  const doc = new Document({
    creator: 'Codex',
    title: dossier.title,
    sections: [{ properties: {}, children }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

function writePdfParagraphs(doc, text, context, options = {}) {
  const paragraphs = splitNarrativeParagraphs(text);
  paragraphs.forEach((paragraph, index) => {
    const paragraphRtl = prefersRtlText(paragraph, context.brand.languageMode, {
      preferDocumentDirection: true,
    });
    const align = options.align === 'center'
      ? 'center'
      : paragraphRtl
        ? 'right'
        : (options.ltrAlign || options.align || 'justify');

    capturePdfPages(doc, () => {
      setPdfFont(doc, Boolean(options.bold), context.brand.typography)
        .fontSize(options.fontSize || 10.5)
        .fillColor(options.color || '#334155')
        .text(formatPdfText(paragraph, context.brand.languageMode), {
          align,
          lineGap: options.lineGap ?? 4,
        });
    }, options.onPageUsed || (() => {}));
    if (index !== paragraphs.length - 1) doc.moveDown(options.paragraphGap ?? 0.55);
  });
}

function writePdfSectionHeading(doc, title, context, options = {}) {
  const align = options.align === 'center'
    ? 'center'
    : prefersRtlText(title, context.brand.languageMode, { preferDocumentDirection: true })
      ? 'right'
      : (options.align || 'left');
  capturePdfPages(doc, () => {
    setPdfFont(doc, true, context.brand.typography)
      .fontSize(options.fontSize || 14)
      .fillColor(options.color || context.brand.primaryColor)
      .text(formatPdfText(title, context.brand.languageMode), { align });
  }, options.onPageUsed || (() => {}));
  doc.moveDown(0.15);
  const lineWidth = 90;
  const y = doc.y;
  const x = align === 'right' ? doc.page.width - doc.page.margins.right - lineWidth : doc.page.margins.left;
  doc.save().lineWidth(1.5).strokeColor(options.ruleColor || context.brand.accentColor).moveTo(x, y).lineTo(x + lineWidth, y).stroke().restore();
  doc.moveDown(0.45);
}

async function buildPdfDossier(dossier, context, images, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 20;
    const usedPages = new Set([0]);
    const markPageUsed = pageIndex => usedPages.add(pageIndex);
    const ensureSpace = minHeight => {
      if (doc.y + minHeight > pageBottom()) doc.addPage();
    };
    const sections = (dossier.sections || []).filter(section => normalizeText(section?.title) || normalizeText(section?.body));
    const buildingRecords = (dossier.buildingRecords || []).filter(building => normalizeText(building?.name) || normalizeText(building?.summary));
    const references = (dossier.references || []).filter(ref => normalizeText(ref?.title) || normalizeText(ref?.note));
    const appendices = (dossier.appendices || []).map(item => normalizeText(item)).filter(Boolean);

    (async () => {
      const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
        suffix: 'pdf_logo',
        maxWidth: 170,
        maxHeight: 80,
      });
      if (logo) {
        try {
          const logoX = (doc.page.width - logo.width) / 2;
          capturePdfPages(doc, () => {
            doc.image(logo.path, logoX, doc.y, {
              width: logo.width,
              height: logo.height,
            });
          }, markPageUsed);
          doc.y += logo.height + 12;
        } catch (error) {
          // Ignore broken logos and continue.
        }
      }

      capturePdfPages(doc, () => {
        setPdfFont(doc, true, context.brand.typography).fontSize(25).fillColor(context.brand.primaryColor).text(formatPdfText(dossier.title, context.brand.languageMode), { align: 'center' });
      }, markPageUsed);
      doc.moveDown(0.35);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography).fontSize(15).fillColor('#334155').text(formatPdfText(dossier.subtitle, context.brand.languageMode), { align: 'center' });
      }, markPageUsed);
      doc.moveDown(0.2);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography).fontSize(10).fillColor('#475569').text(
          formatPdfText(`${context.brand.implementingBody} | ${context.brand.preparationDate}`, context.brand.languageMode),
          { align: 'center' },
        );
      }, markPageUsed);
      doc.moveDown(0.3);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography).fontSize(10).fillColor('#64748b').text(
          formatPdfText(`${labelForLanguage('Consultant Team', '\u0627\u0644\u0641\u0631\u064a\u0642 \u0627\u0644\u0627\u0633\u062a\u0634\u0627\u0631\u064a', context.brand.languageMode)}: ${context.brand.consultantTeam}`, context.brand.languageMode),
          { align: 'center' },
        );
      }, markPageUsed);

      if (images[0] && fs.existsSync(images[0].path)) {
        try {
          doc.moveDown(0.8);
          capturePdfPages(doc, () => {
            doc.image(images[0].path, { fit: [510, 215], align: 'center' });
          }, markPageUsed);
        } catch (error) {
          // Ignore broken images and continue.
        }
      }

      doc.moveDown(1);
      writePdfSectionHeading(doc, labelForLanguage('Executive Summary', '\u0627\u0644\u0645\u0644\u062e\u0635 \u0627\u0644\u062a\u0646\u0641\u064a\u0630\u064a', context.brand.languageMode), context, {
        color: '#0f172a',
        onPageUsed: markPageUsed,
      });
      writePdfParagraphs(doc, dossier.executiveSummary, context, {
        ltrAlign: 'justify',
        onPageUsed: markPageUsed,
      });

      if (normalizeText(dossier.methodology)) {
        ensureSpace(120);
        doc.moveDown(0.6);
        writePdfSectionHeading(doc, labelForLanguage('Methodology', '\u0627\u0644\u0645\u0646\u0647\u062c\u064a\u0629', context.brand.languageMode), context, {
          color: '#0f172a',
          onPageUsed: markPageUsed,
        });
        writePdfParagraphs(doc, dossier.methodology, context, {
          ltrAlign: 'justify',
          onPageUsed: markPageUsed,
        });
      }

      if (sections.length) {
        doc.moveDown(0.75);
        writePdfSectionHeading(doc, labelForLanguage('Table of Contents', '\u062c\u062f\u0648\u0644 \u0627\u0644\u0645\u062d\u062a\u0648\u064a\u0627\u062a', context.brand.languageMode), context, {
          color: '#0f172a',
          fontSize: 13,
          onPageUsed: markPageUsed,
        });
      }
      sections.forEach((section, index) => {
        ensureSpace(20);
        capturePdfPages(doc, () => {
          setPdfFont(doc, false, context.brand.typography).fontSize(10).fillColor('#334155').text(
            formatPdfText(`${index + 1}. ${section.title}`, context.brand.languageMode),
            {
              align: prefersRtlText(section.title, context.brand.languageMode, { preferDocumentDirection: true }) ? 'right' : 'left',
              indent: 10,
            },
          );
        }, markPageUsed);
      });

      sections.forEach(section => {
        ensureSpace(72);
        doc.moveDown(0.9);
        writePdfSectionHeading(doc, section.title, context, { onPageUsed: markPageUsed });
        writePdfParagraphs(doc, section.body, context, {
          ltrAlign: 'justify',
          onPageUsed: markPageUsed,
        });
      });

      if (buildingRecords.length) {
        ensureSpace(72);
        doc.moveDown(0.9);
        writePdfSectionHeading(doc, labelForLanguage('Building Documentation', '\u062a\u0648\u062b\u064a\u0642 \u0627\u0644\u0645\u0628\u0627\u0646\u064a', context.brand.languageMode), context, {
          onPageUsed: markPageUsed,
        });
        buildingRecords.forEach((building, index) => {
          ensureSpace(48);
          capturePdfPages(doc, () => {
            setPdfFont(doc, true, context.brand.typography).fontSize(11.5).fillColor('#0f172a').text(
              formatPdfText(`${index + 1}. ${building.name}`, context.brand.languageMode),
              {
                align: prefersRtlText(building.name, context.brand.languageMode, { preferDocumentDirection: true }) ? 'right' : 'left',
              },
            );
          }, markPageUsed);
          doc.moveDown(0.15);
          writePdfParagraphs(doc, building.summary, context, {
            ltrAlign: 'justify',
            paragraphGap: 0.35,
            onPageUsed: markPageUsed,
          });
          doc.moveDown(0.4);
        });
      }

      if (references.length) {
        ensureSpace(64);
        writePdfSectionHeading(doc, labelForLanguage('References', '\u0627\u0644\u0645\u0631\u0627\u062c\u0639', context.brand.languageMode), context, {
          onPageUsed: markPageUsed,
        });
        references.forEach(ref => {
          ensureSpace(26);
          capturePdfPages(doc, () => {
            setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155').text(
              formatPdfText(`${ref.title} - ${ref.note}`, context.brand.languageMode),
              {
                align: prefersRtlText(`${ref.title} ${ref.note}`, context.brand.languageMode, { preferDocumentDirection: true }) ? 'right' : 'left',
              },
            );
          }, markPageUsed);
          doc.moveDown(0.15);
        });
      }

      if (appendices.length) {
        ensureSpace(64);
        doc.moveDown(0.6);
        writePdfSectionHeading(doc, labelForLanguage('Appendices', '\u0627\u0644\u0645\u0644\u0627\u062d\u0642', context.brand.languageMode), context, {
          onPageUsed: markPageUsed,
        });
        appendices.forEach(item => {
          ensureSpace(20);
          capturePdfPages(doc, () => {
            setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155').text(
              formatPdfText(`- ${item}`, context.brand.languageMode),
              {
                align: prefersRtlText(item, context.brand.languageMode, { preferDocumentDirection: true }) ? 'right' : 'left',
              },
            );
          }, markPageUsed);
        });
      }

      const totalPages = trimTrailingBufferedPages(doc, usedPages);
      for (let i = 0; i < totalPages; i += 1) {
        doc.switchToPage(i);
        capturePdfPages(doc, () => {
          setPdfFont(doc, false, context.brand.typography).fontSize(8.5).fillColor('#64748b').text(
            formatPdfText(labelForLanguage(`Page ${i + 1} of ${totalPages}`, `\u0627\u0644\u0635\u0641\u062d\u0629 ${i + 1} \u0645\u0646 ${totalPages}`, context.brand.languageMode), context.brand.languageMode),
            42,
            doc.page.height - 26,
            { align: 'center', width: doc.page.width - 84 },
          );
        }, markPageUsed);
      }

      doc.end();
    })().catch(reject);

    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}
function collectZipEntries(rootDir, currentDir = rootDir, entries = []) {
  const names = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of names) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectZipEntries(rootDir, fullPath, entries);
      continue;
    }
    entries.push({
      name: toWebPath(path.relative(path.dirname(rootDir), fullPath)),
      data: fs.readFileSync(fullPath),
    });
  }
  return entries;
}

function firstImageFromAssets(assets) {
  const match = assets.find(asset => asset.copiedPath && isWebReadyImage(fileExt(asset.copiedPath)));
  return match ? match.copiedPath : null;
}

async function buildWordBuildingDocument(building, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const rtlLike = isRtlLanguage(context.brand.languageMode);
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
    forcePng: true,
    suffix: 'word_logo',
    maxWidth: 150,
    maxHeight: 64,
  });
  const groupedTypes = building.assets.reduce((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});

  const children = [];
  if (logo && ImageRun && fs.existsSync(logo.path)) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 180 },
      children: [
        new ImageRun({
          data: fs.readFileSync(logo.path),
          transformation: { width: logo.width, height: logo.height },
        }),
      ],
    }));
  }

  children.push(
    createWordParagraph(building.name, context, {
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      bold: true,
      size: 30,
    }),
  );
  children.push(...createWordNarrativeParagraphs(building.summary, context, { alignment: paragraphAlign }));
  children.push(createWordParagraph(labelForLanguage('Available Evidence', 'الأدلة المتاحة', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
    }));

  Object.entries(groupedTypes).forEach(([type, count]) => {
    children.push(createWordParagraph(`${localizedAssetType(type, context.brand.languageMode)}: ${count}`, context, {
      alignment: paragraphAlign,
    }));
  });

  children.push(createWordParagraph(labelForLanguage('Implementation Notes', 'ملاحظات التنفيذ', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
  }));
  children.push(...createWordNarrativeParagraphs(localizeTemplateText(
    `This building record was prepared as part of ${context.brand.projectName}. It summarizes only the evidence actually linked for this building and should be expanded further only when additional verified material becomes available.`,
    `أُعد هذا السجل الخاص بالمبنى ضمن ${context.brand.projectName}. وهو يلخص فقط الأدلة المرتبطة فعليا بهذا المبنى، ولا ينبغي توسيعه إلا عند توفر مواد إضافية موثقة.`,
    context.brand.languageMode,
  ), context, { alignment: paragraphAlign }));

  const doc = new Document({ creator: 'Codex', title: building.name, sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

async function buildPdfBuildingDocument(building, context, imagePath, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const rtlLike = isRtlLanguage(context.brand.languageMode);
    const align = rtlLike ? 'right' : 'left';

    (async () => {
      const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
        suffix: 'pdf_logo',
        maxWidth: 150,
        maxHeight: 64,
      });

      if (logo) {
        try {
          const logoX = (doc.page.width - logo.width) / 2;
          doc.image(logo.path, logoX, doc.y, { width: logo.width, height: logo.height });
          doc.y += logo.height + 12;
        } catch (error) {
          // Ignore broken logo image.
        }
      }

      setPdfFont(doc, true, context.brand.typography).fontSize(22).fillColor(context.brand.primaryColor).text(formatPdfText(building.name, context.brand.languageMode), { align: 'center' });
      doc.moveDown(0.3);
      setPdfFont(doc, false, context.brand.typography).fontSize(10).fillColor('#475569').text(formatPdfText(context.brand.projectName, context.brand.languageMode), { align: 'center' });

      if (imagePath && fs.existsSync(imagePath)) {
        try {
          doc.moveDown(0.8);
          doc.image(imagePath, { fit: [510, 220], align: 'center' });
        } catch (error) {
          // Ignore broken preview image.
        }
      }

      doc.moveDown(0.9);
      writePdfSectionHeading(doc, labelForLanguage('Building Overview', 'نظرة عامة على المبنى', context.brand.languageMode), context, { color: '#0f172a' });
      writePdfParagraphs(doc, building.summary, context, { align: rtlLike ? 'right' : 'justify' });
      doc.moveDown(0.6);
      writePdfSectionHeading(doc, labelForLanguage('Available Content', 'المحتوى المتاح', context.brand.languageMode), context, { color: '#0f172a', fontSize: 12.5 });
      building.assets.slice(0, 20).forEach(asset => {
        setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155').text(
          formatPdfText(`- ${asset.name} (${localizedAssetType(asset.type, context.brand.languageMode)})`, context.brand.languageMode),
          { align },
        );
      });

      doc.end();
    })().catch(reject);

    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function buildResponsePreview(context, dossier, contentModel, outputFiles) {
  return {
    title: context.brand.projectName,
    dossierTitle: dossier.title,
    assetCount: contentModel.counts.totalAssets,
    buildingDocuments: dossier.buildingRecords.length,
    generatedOutputs: outputFiles.length,
  };
}

function buildResponsePreview(context, dossier, contentModel, outputFiles) {
  return {
    title: context.brand.projectName,
    dossierTitle: dossier.title,
    assetCount: contentModel.counts.totalAssets,
    buildingDocuments: dossier.buildingRecords.length,
    generatedOutputs: outputFiles.length,
  };
}

function pptParagraphXml(text, options = {}) {
  const font = normalizeText(options.font, 'Arial');
  const size = options.size || 1200;
  const languageMode = options.languageMode || 'english';
  return splitNarrativeParagraphs(text || ' ').map(paragraph => {
    const rtl = prefersRtlText(paragraph, languageMode, {
      forceRtl: options.rtl,
      preferDocumentDirection: true,
    });
    const lang = rtl ? 'ar-SA' : 'en-US';
    const content = rtl ? formatPdfText(paragraph, languageMode) : prepareDirectionalText(paragraph, languageMode);
    return `<a:p><a:pPr algn="${rtl ? 'r' : 'l'}" rtl="${rtl ? '1' : '0'}"/><a:r><a:rPr lang="${lang}" sz="${size}"${options.bold ? ' b="1"' : ''}><a:latin typeface="${xmlEscape(font)}"/><a:cs typeface="${xmlEscape(font)}"/></a:rPr><a:t>${xmlEscape(content)}</a:t></a:r></a:p>`;
  }).join('');
}

function pxToEmu(value) {
  return Math.round(Number(value || 0) * 9525);
}

async function buildSimplePptx(slides, reportTitle, outPath, options = {}) {
  const rtlLike = isRtlLanguage(options.languageMode);
  const font = normalizeText(options.typography, 'Arial');
  const logo = await prepareLogoPlacement(options.logoPath, path.dirname(outPath), {
    forcePng: true,
    suffix: 'ppt_logo',
    maxWidth: 140,
    maxHeight: 54,
  });
  const logoWidthEmu = logo ? pxToEmu(logo.width) : 0;
  const logoHeightEmu = logo ? pxToEmu(logo.height) : 0;
  const logoXEmu = logo ? (9144000 - 457200 - logoWidthEmu) : 0;
  const logoYEmu = 228600;
  const slideEntries = [];
  const slideRelEntries = [];
  const imageEntries = [];
  const slideIdEntries = [];
  const presentationRelEntries = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];

  slides.forEach((slide, index) => {
    const slideNo = index + 1;
    const hasImage = slide.imagePath && fs.existsSync(slide.imagePath) && isWebReadyImage(fileExt(slide.imagePath));
    const mediaName = hasImage ? `slide${slideNo}${fileExt(slide.imagePath) || '.png'}` : '';
    const logoMediaName = logo ? `slide${slideNo}_logo${fileExt(logo.path) || '.png'}` : '';

    slideIdEntries.push(`<p:sldId id="${255 + slideNo}" r:id="rId${slideNo + 1}"/>`);
    presentationRelEntries.push(`<Relationship Id="rId${slideNo + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`);

    const pictureXml = hasImage ? `
      <p:pic>
        <p:nvPicPr><p:cNvPr id="4" name="Picture ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="2400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>` : '';
    const logoXml = logo ? `
      <p:pic>
        <p:nvPicPr><p:cNvPr id="5" name="Logo ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="${hasImage ? 'rId3' : 'rId2'}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${logoXEmu}" y="${logoYEmu}"/><a:ext cx="${logoWidthEmu}" cy="${logoHeightEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>` : '';

    slideEntries.push({
      name: `ppt/slides/slide${slideNo}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="8229600" cy="685800"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr wrap="square" rtlCol="${rtlLike ? '1' : '0'}"/><a:lstStyle/>${pptParagraphXml(slide.title, { rtl: rtlLike, font, size: 2400, bold: true, languageMode: options.languageMode })}</p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="${hasImage ? '3940800' : '1371600'}"/><a:ext cx="8229600" cy="${hasImage ? '1000000' : '2500000'}"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr wrap="square" rtlCol="${rtlLike ? '1' : '0'}"/><a:lstStyle/>${pptParagraphXml(slide.subtitle, { rtl: rtlLike, font, size: 1200, languageMode: options.languageMode })}</p:txBody>
      </p:sp>${pictureXml}${logoXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    });

    if (logo) {
      imageEntries.push({ name: `ppt/media/${logoMediaName}`, data: fs.readFileSync(logo.path) });
    }
    if (hasImage) {
      imageEntries.push({ name: `ppt/media/${mediaName}`, data: fs.readFileSync(slide.imagePath) });
      slideRelEntries.push({
        name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>
  ${logo ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${logoMediaName}"/>` : ''}
</Relationships>`,
      });
    } else {
      slideRelEntries.push({
        name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${logo ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${logoMediaName}"/>` : ''}
</Relationships>`,
      });
    }
  });

  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${slides.map((_, idx) => `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
</Types>`,
    },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codex</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips></Properties>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(reportTitle)}</dc:title><dc:creator>Codex</dc:creator><cp:lastModifiedBy>Codex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>` },
    { name: 'ppt/presentation.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIdEntries.join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` },
    { name: 'ppt/_rels/presentation.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presentationRelEntries.join('')}<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId${slides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId${slides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/></Relationships>` },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>` },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: 'ppt/theme/theme1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Service06"><a:themeElements><a:clrScheme name="Service06"><a:dk1><a:srgbClr val="1A3554"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0F172A"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="DFAF67"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="6366F1"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Service06"><a:majorFont><a:latin typeface="${xmlEscape(font)}"/><a:cs typeface="${xmlEscape(font)}"/></a:majorFont><a:minorFont><a:latin typeface="${xmlEscape(font)}"/><a:cs typeface="${xmlEscape(font)}"/></a:minorFont></a:fontScheme><a:fmtScheme name="Service06"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>` },
    { name: 'ppt/presProps.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    { name: 'ppt/viewProps.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    { name: 'ppt/tableStyles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def=""/>` },
    ...slideEntries,
    ...slideRelEntries,
    ...imageEntries,
  ];

  fs.writeFileSync(outPath, createStoredZip(entries));
}

function applyWorksheetDirection(worksheet, languageMode) {
  if (isRtlLanguage(languageMode)) {
    worksheet.views = [{ rightToLeft: true }];
    worksheet.eachRow(row => {
      row.alignment = { horizontal: 'right', vertical: 'top', wrapText: true };
    });
  } else {
    worksheet.eachRow(row => {
      row.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
    });
  }
}

async function buildExcelManifest(context, dossier, contentModel, deliverables, outPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_06_NAME;
  workbook.created = new Date();

  const languageMode = context.brand.languageMode;
  const summary = workbook.addWorksheet(labelForLanguage('Project Summary', 'ملخص المشروع', languageMode));
  summary.columns = [
    { header: labelForLanguage('Field', 'الحقل', languageMode), width: 28 },
    { header: labelForLanguage('Value', 'القيمة', languageMode), width: 70 },
  ];
  [
    [labelForLanguage('Project Name', 'اسم المشروع', languageMode), context.brand.projectName],
    [labelForLanguage('Implementing Body', 'الجهة المنفذة', languageMode), context.brand.implementingBody],
    [labelForLanguage('Preparation Date', 'تاريخ الإعداد', languageMode), context.brand.preparationDate],
    [labelForLanguage('Consultant Team', 'الفريق الاستشاري', languageMode), context.brand.consultantTeam],
    [labelForLanguage('Language Mode', 'لغة الإخراج', languageMode), localizedLanguageMode(context.brand.languageMode, languageMode)],
    [labelForLanguage('Assets Indexed', 'الأصول المفهرسة', languageMode), contentModel.counts.totalAssets],
    [labelForLanguage('Images', 'الصور', languageMode), contentModel.counts.images],
    [labelForLanguage('Reports', 'التقارير', languageMode), contentModel.counts.reports],
    [labelForLanguage('Models', 'النماذج', languageMode), contentModel.counts.models],
    [labelForLanguage('Presentations', 'العروض التقديمية', languageMode), contentModel.counts.presentations],
  ].forEach(row => summary.addRow(row));
  applyWorksheetDirection(summary, languageMode);

  const assets = workbook.addWorksheet(labelForLanguage('Asset Register', 'سجل الأصول', languageMode));
  assets.columns = [
    { header: labelForLanguage('Source', 'المصدر', languageMode), width: 28 },
    { header: labelForLanguage('Building', 'المبنى', languageMode), width: 28 },
    { header: labelForLanguage('District', 'النطاق', languageMode), width: 28 },
    { header: labelForLanguage('File', 'الملف', languageMode), width: 42 },
    { header: labelForLanguage('Type', 'النوع', languageMode), width: 18 },
    { header: labelForLanguage('Usage', 'الاستخدام', languageMode), width: 24 },
    { header: labelForLanguage('Size KB', 'الحجم كيلوبايت', languageMode), width: 12 },
  ];
  contentModel.assets.forEach(asset => {
    assets.addRow([asset.sourceLabel, asset.building, asset.district, asset.name, localizedAssetType(asset.type, languageMode), asset.usage, asset.sizeKB]);
  });
  applyWorksheetDirection(assets, languageMode);

  const outputs = workbook.addWorksheet(labelForLanguage('Generated Outputs', 'المخرجات الناتجة', languageMode));
  outputs.columns = [
    { header: labelForLanguage('Label', 'الاسم', languageMode), width: 34 },
    { header: labelForLanguage('Relative Path', 'المسار النسبي', languageMode), width: 60 },
    { header: labelForLanguage('Extension', 'الامتداد', languageMode), width: 14 },
  ];
  deliverables.forEach(file => outputs.addRow([file.label, file.relativePath, file.ext]));
  applyWorksheetDirection(outputs, languageMode);

  const buildings = workbook.addWorksheet(labelForLanguage('Buildings', 'المباني', languageMode));
  buildings.columns = [
    { header: labelForLanguage('Building', 'المبنى', languageMode), width: 34 },
    { header: labelForLanguage('Summary', 'الملخص', languageMode), width: 90 },
  ];
  dossier.buildingRecords.forEach(building => buildings.addRow([building.name, building.summary]));
  applyWorksheetDirection(buildings, languageMode);

  await workbook.xlsx.writeFile(outPath);
}

function buildInfographicSvg(context, contentModel, dossier) {
  const languageMode = context.brand.languageMode;
  const rtlLike = isRtlLanguage(languageMode);
  const anchor = rtlLike ? 'end' : 'start';
  const baseX = rtlLike ? 1116 : 84;
  const font = fontFamilyStack(context.brand.typography, languageMode);
  const summaryText = compactText(dossier.executiveSummary, 180);
  const sourceBlocks = Object.entries(contentModel.bySource)
    .map(([name, count], index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = rtlLike ? 1120 - (col * 290) : 80 + (col * 290);
      const y = 280 + (row * 90);
      const rectX = rtlLike ? x - 250 : x;
      const textX = rtlLike ? x - 18 : x + 18;
      return `
  <rect x="${rectX}" y="${y}" width="250" height="64" rx="16" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.12)" />
  <text x="${textX}" y="${y + 28}" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#f8fafc">${xmlEscape(prepareDirectionalText(name, languageMode))}</text>
  <text x="${textX}" y="${y + 50}" text-anchor="${anchor}" font-size="26" font-family="${xmlEscape(font)}" font-weight="700" fill="${context.brand.accentColor}">${count}</text>`;
    }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${context.brand.primaryColor}" />
      <stop offset="100%" stop-color="#0f172a" />
    </linearGradient>
  </defs>
  <rect width="1200" height="900" fill="url(#bg)" />
  <rect x="54" y="54" width="1092" height="792" rx="32" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" />
  <text x="${baseX}" y="122" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="28" font-family="${xmlEscape(font)}" font-weight="700" fill="#ffffff">${xmlEscape(prepareDirectionalText(context.brand.projectName, languageMode))}</text>
  <text x="${baseX}" y="156" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="16" font-family="${xmlEscape(font)}" fill="#dbeafe">${xmlEscape(prepareDirectionalText(dossier.title, languageMode))}</text>
  <text x="${rtlLike ? 1116 : 84}" y="220" text-anchor="${anchor}" font-size="64" font-family="${xmlEscape(font)}" font-weight="700" fill="${context.brand.accentColor}">${contentModel.counts.totalAssets}</text>
  <text x="${rtlLike ? 1116 : 84}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Indexed project assets', 'أصول المشروع المفهرسة', languageMode))}</text>
  <text x="${rtlLike ? 770 : 430}" y="220" text-anchor="${anchor}" font-size="64" font-family="${xmlEscape(font)}" font-weight="700" fill="#38bdf8">${dossier.buildingRecords.length}</text>
  <text x="${rtlLike ? 770 : 430}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Building document groups', 'مجموعات وثائق المباني', languageMode))}</text>
  <text x="${rtlLike ? 420 : 760}" y="220" text-anchor="${anchor}" font-size="64" font-family="${xmlEscape(font)}" font-weight="700" fill="#10b981">${contentModel.counts.html + contentModel.counts.presentations + contentModel.counts.models}</text>
  <text x="${rtlLike ? 420 : 760}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Digital and presentation outputs', 'المخرجات الرقمية والعرضية', languageMode))}</text>
  ${sourceBlocks}
  <text x="${baseX}" y="740" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#f8fafc">${xmlEscape(labelForLanguage('Coverage', 'نطاق التغطية', languageMode))}</text>
  <text x="${baseX}" y="772" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="15" font-family="${xmlEscape(font)}" fill="#cbd5e1">${xmlEscape(prepareDirectionalText(summaryText, languageMode))}</text>
</svg>`;
}

function buildPortfolioHtml(context, dossier, copiedAssets, outPath) {
  const htmlDir = path.dirname(outPath);
  const rtlLike = isRtlLanguage(context.brand.languageMode);
  const heroImages = copiedAssets.filter(asset => asset.type === 'image' && asset.usage !== 'logo').slice(0, 8);
  const mapFrames = copiedAssets.filter(asset => asset.usage === 'interactive-map').slice(0, 2);
  const modelFrames = copiedAssets.filter(asset => asset.usage === 'interactive-viewer').slice(0, 2);
  const logoAsset = copiedAssets.find(asset => asset.usage === 'logo' && asset.copiedPath) || null;
  const logoHtml = logoAsset
    ? `<div class="brand-logo"><img src="${xmlEscape(toWebPath(path.relative(htmlDir, logoAsset.copiedPath)))}" alt="${xmlEscape(context.brand.projectName)} logo"></div>`
    : '';
  const fontStack = fontFamilyStack(context.brand.typography, context.brand.languageMode);
  const cards = dossier.buildingRecords.map(building => `
      <article class="panel narrative">
        <h3 ${htmlDirectionAttrs(building.name, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(building.name, context.brand.languageMode))}</h3>
        ${splitNarrativeParagraphs(building.summary).map(paragraph => `<p ${htmlDirectionAttrs(paragraph, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(paragraph, context.brand.languageMode))}</p>`).join('')}
      </article>
  `).join('\n');
  const gallery = heroImages.map(asset => {
    const rel = toWebPath(path.relative(htmlDir, asset.copiedPath));
    return `<figure class="shot"><img src="${xmlEscape(rel)}" alt="${xmlEscape(asset.name)}"><figcaption ${htmlDirectionAttrs(asset.name, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(asset.name, context.brand.languageMode))}</figcaption></figure>`;
  }).join('\n');
  const iframeBlocks = [...mapFrames, ...modelFrames].map(asset => {
    const rel = toWebPath(path.relative(htmlDir, asset.copiedPath));
    return `<iframe class="embed" src="${xmlEscape(rel)}" title="${xmlEscape(asset.name)}"></iframe>`;
  }).join('\n');
  const narrativeSections = dossier.sections.map(section => `
      <section class="doc-section panel narrative">
        <h2 ${htmlDirectionAttrs(section.title, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(section.title, context.brand.languageMode))}</h2>
        ${splitNarrativeParagraphs(section.body).map(paragraph => `<p ${htmlDirectionAttrs(paragraph, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(paragraph, context.brand.languageMode))}</p>`).join('')}
      </section>
  `).join('\n');
  const references = dossier.references.map(ref => {
    const text = `${ref.title} - ${ref.note}`;
    return `<li ${htmlDirectionAttrs(text, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(text, context.brand.languageMode))}</li>`;
  }).join('');
  const html = `<!DOCTYPE html>
<html lang="${rtlLike ? 'ar' : 'en'}" dir="${rtlLike ? 'rtl' : 'ltr'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${xmlEscape(context.brand.projectName)}</title>
  <style>
    :root{--bg:${context.brand.primaryColor};--card:#102033;--line:rgba(255,255,255,.12);--accent:${context.brand.accentColor};--text:#f8fafc;--muted:#cbd5e1;--page-align:${rtlLike ? 'right' : 'left'}}
    *{box-sizing:border-box}
    body{margin:0;font-family:${fontStack};background:radial-gradient(circle at top left,${context.brand.primaryColor},#09111b 60%);color:var(--text);text-align:var(--page-align)}
    h1,h2,h3,p,li,figcaption,.eyebrow{unicode-bidi:plaintext}
    .rtl-block{direction:rtl;text-align:right}
    .ltr-block{direction:ltr;text-align:left}
    .wrap{max-width:1180px;margin:0 auto;padding:40px 22px 60px}
    .hero{padding:38px;border:1px solid var(--line);border-radius:30px;background:rgba(255,255,255,.04);backdrop-filter:blur(10px)}
    .brand-logo{display:flex;justify-content:center;margin-bottom:18px}
    .brand-logo img{max-width:180px;max-height:88px;object-fit:contain;display:block}
    .eyebrow{display:inline-block;padding:8px 14px;border-radius:999px;background:rgba(223,175,103,.14);color:var(--accent);font-weight:700;font-size:13px}
    h1{font-size:42px;line-height:1.15;margin:18px 0 10px}
    h2{margin:0 0 14px;font-size:28px}
    h3{margin:0 0 10px}
    p{color:var(--muted);line-height:1.9;margin:0 0 12px}
    ul{margin:0;padding-${rtlLike ? 'right' : 'left'}:20px}
    li{color:var(--muted);line-height:1.8;margin-bottom:8px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px;margin-top:26px}
    .panel{background:rgba(16,32,51,.88);border:1px solid var(--line);border-radius:22px;padding:22px}
    .metrics strong{font-size:34px;display:block;margin-bottom:8px}
    .narrative{padding:26px}
    .stack{display:grid;gap:18px;margin-top:28px}
    .gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:18px}
    .shot{margin:0;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:18px;overflow:hidden}
    .shot img{width:100%;height:180px;object-fit:cover;display:block}
    .shot figcaption{padding:12px 14px;font-size:13px;color:var(--muted)}
    .embeds{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:20px}
    .embed{width:100%;min-height:380px;border:1px solid var(--line);border-radius:22px;background:#fff}
    @media (max-width:700px){h1{font-size:32px}.hero{padding:26px}}
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      ${logoHtml}
      <span class="eyebrow" ${htmlDirectionAttrs(labelForLanguage('Final Project Dossier', '\u0627\u0644\u0648\u062b\u064a\u0642\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629 \u0644\u0644\u0645\u0634\u0631\u0648\u0639', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Final Project Dossier', '\u0627\u0644\u0648\u062b\u064a\u0642\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629 \u0644\u0644\u0645\u0634\u0631\u0648\u0639', context.brand.languageMode))}</span>
      <h1 ${htmlDirectionAttrs(context.brand.projectName, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(context.brand.projectName, context.brand.languageMode))}</h1>
      ${splitNarrativeParagraphs(dossier.executiveSummary).map(paragraph => `<p ${htmlDirectionAttrs(paragraph, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(paragraph, context.brand.languageMode))}</p>`).join('')}
      <div class="grid">
        <div class="panel metrics"><strong>${copiedAssets.length}</strong><p ${htmlDirectionAttrs(labelForLanguage('Packaged files organized into the final delivery structure.', '\u0645\u0644\u0641\u0627\u062a \u0645\u0646\u0638\u0645\u0629 \u062f\u0627\u062e\u0644 \u0628\u0646\u064a\u0629 \u0627\u0644\u062a\u0633\u0644\u064a\u0645 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629.', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Packaged files organized into the final delivery structure.', '\u0645\u0644\u0641\u0627\u062a \u0645\u0646\u0638\u0645\u0629 \u062f\u0627\u062e\u0644 \u0628\u0646\u064a\u0629 \u0627\u0644\u062a\u0633\u0644\u064a\u0645 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629.', context.brand.languageMode))}</p></div>
        <div class="panel metrics"><strong>${dossier.buildingRecords.length}</strong><p ${htmlDirectionAttrs(labelForLanguage('Building-level documentation sections.', '\u0623\u0642\u0633\u0627\u0645 \u062a\u0648\u062b\u064a\u0642 \u0639\u0644\u0649 \u0645\u0633\u062a\u0648\u0649 \u0627\u0644\u0645\u0628\u0627\u0646\u064a.', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Building-level documentation sections.', '\u0623\u0642\u0633\u0627\u0645 \u062a\u0648\u062b\u064a\u0642 \u0639\u0644\u0649 \u0645\u0633\u062a\u0648\u0649 \u0627\u0644\u0645\u0628\u0627\u0646\u064a.', context.brand.languageMode))}</p></div>
        <div class="panel metrics"><strong>${Object.keys(context.contentModel.bySource).length}</strong><p ${htmlDirectionAttrs(labelForLanguage('Linked source sets represented honestly in the dossier.', '\u0645\u062c\u0645\u0648\u0639\u0627\u062a \u0645\u0635\u0627\u062f\u0631 \u0645\u0631\u062a\u0628\u0637\u0629 \u0645\u0645\u062b\u0644\u0629 \u0628\u0648\u0636\u0648\u062d \u062f\u0627\u062e\u0644 \u0627\u0644\u0648\u062b\u064a\u0642\u0629.', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Linked source sets represented honestly in the dossier.', '\u0645\u062c\u0645\u0648\u0639\u0627\u062a \u0645\u0635\u0627\u062f\u0631 \u0645\u0631\u062a\u0628\u0637\u0629 \u0645\u0645\u062b\u0644\u0629 \u0628\u0648\u0636\u0648\u062d \u062f\u0627\u062e\u0644 \u0627\u0644\u0648\u062b\u064a\u0642\u0629.', context.brand.languageMode))}</p></div>
      </div>
    </section>
    <div class="stack">
      <section class="panel narrative">
        <h2 ${htmlDirectionAttrs(labelForLanguage('Methodology', '\u0627\u0644\u0645\u0646\u0647\u062c\u064a\u0629', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Methodology', '\u0627\u0644\u0645\u0646\u0647\u062c\u064a\u0629', context.brand.languageMode))}</h2>
        ${splitNarrativeParagraphs(dossier.methodology).map(paragraph => `<p ${htmlDirectionAttrs(paragraph, context.brand.languageMode)}>${xmlEscape(prepareDirectionalText(paragraph, context.brand.languageMode))}</p>`).join('')}
      </section>
      ${narrativeSections}
      <section class="panel narrative">
        <h2 ${htmlDirectionAttrs(labelForLanguage('Building Documentation', '\u062a\u0648\u062b\u064a\u0642 \u0627\u0644\u0645\u0628\u0627\u0646\u064a', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Building Documentation', '\u062a\u0648\u062b\u064a\u0642 \u0627\u0644\u0645\u0628\u0627\u0646\u064a', context.brand.languageMode))}</h2>
        <div class="grid">${cards}</div>
      </section>
      <section class="panel narrative">
        <h2 ${htmlDirectionAttrs(labelForLanguage('Visual Gallery', '\u0627\u0644\u0645\u0639\u0631\u0636 \u0627\u0644\u0628\u0635\u0631\u064a', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Visual Gallery', '\u0627\u0644\u0645\u0639\u0631\u0636 \u0627\u0644\u0628\u0635\u0631\u064a', context.brand.languageMode))}</h2>
        <div class="gallery">${gallery}</div>
      </section>
      <section class="panel narrative">
        <h2 ${htmlDirectionAttrs(labelForLanguage('Interactive Material', '\u0627\u0644\u0645\u062d\u062a\u0648\u0649 \u0627\u0644\u062a\u0641\u0627\u0639\u0644\u064a', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('Interactive Material', '\u0627\u0644\u0645\u062d\u062a\u0648\u0649 \u0627\u0644\u062a\u0641\u0627\u0639\u0644\u064a', context.brand.languageMode))}</h2>
        <div class="embeds">${iframeBlocks || `<div class="panel"><p ${htmlDirectionAttrs(labelForLanguage('No interactive HTML outputs were linked. The final package still includes structured standalone files and narrative documentation.', '\u0644\u0645 \u064a\u062a\u0645 \u0631\u0628\u0637 \u0645\u062e\u0631\u062c\u0627\u062a HTML \u062a\u0641\u0627\u0639\u0644\u064a\u0629\u060c \u0648\u0645\u0639 \u0630\u0644\u0643 \u062a\u062a\u0636\u0645\u0646 \u0627\u0644\u062d\u0632\u0645\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629 \u0645\u0644\u0641\u0627\u062a \u0645\u0633\u062a\u0642\u0644\u0629 \u0645\u0646\u0638\u0645\u0629 \u0648\u0648\u062b\u064a\u0642\u0629 \u0633\u0631\u062f\u064a\u0629.', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('No interactive HTML outputs were linked. The final package still includes structured standalone files and narrative documentation.', '\u0644\u0645 \u064a\u062a\u0645 \u0631\u0628\u0637 \u0645\u062e\u0631\u062c\u0627\u062a HTML \u062a\u0641\u0627\u0639\u0644\u064a\u0629\u060c \u0648\u0645\u0639 \u0630\u0644\u0643 \u062a\u062a\u0636\u0645\u0646 \u0627\u0644\u062d\u0632\u0645\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629 \u0645\u0644\u0641\u0627\u062a \u0645\u0633\u062a\u0642\u0644\u0629 \u0645\u0646\u0638\u0645\u0629 \u0648\u0648\u062b\u064a\u0642\u0629 \u0633\u0631\u062f\u064a\u0629.', context.brand.languageMode))}</p></div>`}</div>
      </section>
      <section class="panel narrative">
        <h2 ${htmlDirectionAttrs(labelForLanguage('References', '\u0627\u0644\u0645\u0631\u0627\u062c\u0639', context.brand.languageMode), context.brand.languageMode)}>${xmlEscape(labelForLanguage('References', '\u0627\u0644\u0645\u0631\u0627\u062c\u0639', context.brand.languageMode))}</h2>
        <ul>${references}</ul>
      </section>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(outPath, html);
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
  ensureDir(jobDir);

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const uploadedFilesSummary = summarizeUploadedFiles(uploadedFiles);
  const requestedJobIds = [
    ...parseCsvList(req.body.service1JobId),
    ...parseCsvList(req.body.service2JobId),
    ...parseCsvList(req.body.service3JobId),
    ...parseCsvList(req.body.service4JobId),
    ...parseCsvList(req.body.service5JobId),
  ];

  let jobRecord = null;
  if (Job) {
    try {
      jobRecord = await Job.create({
        jobId,
        service: 6,
        status: 'processing',
        inputFiles: uploadedFiles.map(file => ({
          originalName: file.originalname,
          storedPath: file.path,
          sizeBytes: file.size,
        })),
        metadata: { request: req.body || {} },
      });
    } catch (error) {
      // Optional DB persistence only.
    }
  }

  try {
    const linkedJobs = [];
    for (const linkedJobId of requestedJobIds) {
      linkedJobs.push(loadJobContext(linkedJobId));
    }

    for (const parsedMeta of uploadedFilesSummary.parsedMetadata) {
      linkedJobs.push({
        jobId: parsedMeta.jobId || `uploaded_${uuidv4().slice(0, 8)}`,
        jobDir: path.join(UPLOADS_DIR, '_virtual'),
        service: parsedMeta.service,
        serviceName: parsedMeta.serviceName || SERVICE_NAMES[parsedMeta.service],
        title: normalizeText(parsedMeta.buildingName) || normalizeText(parsedMeta.districtName) || normalizeText(parsedMeta.project?.title) || SERVICE_NAMES[parsedMeta.service],
        buildingName: normalizeText(parsedMeta.buildingName) || normalizeText(parsedMeta.project?.buildingName),
        districtName: normalizeText(parsedMeta.districtName) || normalizeText(parsedMeta.project?.districtName),
        city: normalizeText(parsedMeta.city) || normalizeText(parsedMeta.project?.city),
        processedAt: parsedMeta.processedAt || parsedMeta.generatedAt || '',
        metadata: parsedMeta,
        files: [],
        representativeImages: [],
      });
    }

    const dedupedJobs = dedupeByJobId(linkedJobs);
    const context = buildProjectContext(req.body || {}, dedupedJobs, uploadedFilesSummary);
    const contentModel = buildContentModel(context.project, dedupedJobs, uploadedFilesSummary, context.brand.languageMode);
    context.contentModel = contentModel;
    const dossier = buildDossierModel(context, dedupedJobs, contentModel);

    const packageRootName = `RUAA_Project_${slugify(context.brand.projectName, 'project')}`;
    const packageRoot = path.join(jobDir, packageRootName);
    ensureDir(packageRoot);

    const copiedAssets = copyAssetsIntoPackage(packageRoot, contentModel, context.brand);
    context.brand.logoPath = firstLogoFromAssets(copiedAssets)?.copiedPath || null;
    const dossierPdfDir = path.join(packageRoot, '06_Dossier', 'Complete_Dossier_PDF');
    const dossierWordDir = path.join(packageRoot, '06_Dossier', 'Complete_Dossier_Word');
    const buildingDir = path.join(packageRoot, '06_Dossier', 'Individual_Buildings');
    const portfolioDir = path.join(packageRoot, '07_Digital_Portfolio', 'HTML_Website');
    const mediaDir = path.join(packageRoot, '08_Media', 'Infographics');
    const videoDir = path.join(packageRoot, '08_Media', 'Videos');
    const reportsDir = path.join(packageRoot, '04_Reports', 'Data_Excel');
    [dossierPdfDir, dossierWordDir, buildingDir, portfolioDir, mediaDir, videoDir, reportsDir].forEach(ensureDir);

    const dossierPdfPath = path.join(dossierPdfDir, 'main_project_dossier.pdf');
    const dossierWordPath = path.join(dossierWordDir, 'main_project_dossier.docx');
    const projectPptPath = path.join(packageRoot, '05_Presentations', 'PPT', 'project_summary.pptx');
    ensureDir(path.dirname(projectPptPath));
    const outputManifestPath = path.join(reportsDir, 'generated_outputs.xlsx');
    const metadataSummaryPath = path.join(packageRoot, '00_Project_Metadata', 'package_manifest.json');
    ensureDir(path.dirname(metadataSummaryPath));
    const readmePath = path.join(packageRoot, 'README.txt');
    const userGuidePath = path.join(packageRoot, 'USER_GUIDE.txt');
    const portfolioHtmlPath = path.join(portfolioDir, 'index.html');
    const promoScriptPath = path.join(videoDir, 'promo_script.txt');
    const captionsPath = path.join(videoDir, 'social_captions.txt');
    const bundleZipPath = path.join(jobDir, `${packageRootName}.zip`);

    const representativeImages = copiedAssets
      .filter(asset => asset.copiedPath && asset.usage !== 'logo' && isWebReadyImage(fileExt(asset.copiedPath)))
      .slice(0, 8)
      .map(asset => ({ path: asset.copiedPath, caption: asset.name }));

    await buildWordDossier(dossier, context, dossierWordPath);
    await buildPdfDossier(dossier, context, representativeImages, dossierPdfPath);

    const buildingOutputs = [];
    for (const building of dossier.buildingRecords) {
      const slug = slugify(building.name, 'building');
      const buildingWordPath = path.join(buildingDir, `${slug}.docx`);
      const buildingPdfPath = path.join(buildingDir, `${slug}.pdf`);
      const buildingPptPath = path.join(buildingDir, `${slug}.pptx`);
      const imagePath = firstImageFromAssets(copiedAssets.filter(asset => asset.building === building.name));
      await buildWordBuildingDocument(building, context, buildingWordPath);
      await buildPdfBuildingDocument(building, context, imagePath, buildingPdfPath);
      await buildSimplePptx([
        {
          title: building.name,
          subtitle: building.summary,
          imagePath,
        },
        {
          title: labelForLanguage('Available Outputs', 'المخرجات المتاحة', context.brand.languageMode),
          subtitle: building.assets.slice(0, 10).map(asset => `${asset.name} (${localizedAssetType(asset.type, context.brand.languageMode)})`).join(' | ')
            || localizeTemplateText('No building-specific files were indexed.', 'لم يتم فهرسة ملفات خاصة بهذا المبنى.', context.brand.languageMode),
          imagePath: null,
        },
      ], building.name, buildingPptPath, {
        languageMode: context.brand.languageMode,
        typography: context.brand.typography,
        logoPath: context.brand.logoPath,
      });

      buildingOutputs.push(
        { label: `${building.name} (${labelForLanguage('Word', 'وورد', context.brand.languageMode)})`, path: buildingWordPath },
        { label: `${building.name} (${labelForLanguage('PDF', 'بي دي إف', context.brand.languageMode)})`, path: buildingPdfPath },
        { label: `${building.name} (${labelForLanguage('PPTX', 'بوربوينت', context.brand.languageMode)})`, path: buildingPptPath },
      );
    }

    await buildSimplePptx([
      {
        title: context.brand.projectName,
        subtitle: dossier.executiveSummary,
        imagePath: representativeImages[0]?.path || null,
      },
      {
        title: labelForLanguage('Documentation Scope', 'نطاق التوثيق', context.brand.languageMode),
        subtitle: dossier.methodology,
        imagePath: representativeImages[1]?.path || null,
      },
      {
        title: labelForLanguage('Building Files', 'ملفات المباني', context.brand.languageMode),
        subtitle: dossier.buildingRecords.map(building => building.name).join(' | ')
          || localizeTemplateText('General project package', 'حزمة مشروع عامة', context.brand.languageMode),
        imagePath: representativeImages[2]?.path || null,
      },
    ], context.brand.projectName, projectPptPath, {
      languageMode: context.brand.languageMode,
      typography: context.brand.typography,
      logoPath: context.brand.logoPath,
    });

    const infographicPaths = await buildInfographics(context, contentModel, dossier, mediaDir);
    fs.writeFileSync(promoScriptPath, buildPromoScript(context, dossier, contentModel));
    fs.writeFileSync(captionsPath, buildSocialCaptions(context, contentModel));
    fs.writeFileSync(userGuidePath, [
      localizeTemplateText(`${context.brand.projectName} - User Guide`, `${context.brand.projectName} - دليل الاستخدام`, context.brand.languageMode),
      '',
      localizeTemplateText('1. Open the PDF dossier for official review or printing.', '1. افتح ملف PDF الخاص بالوثيقة الشاملة للمراجعة الرسمية أو الطباعة.', context.brand.languageMode),
      localizeTemplateText('2. Open the DOCX dossier when editable narrative formatting is required.', '2. افتح ملف DOCX عندما تكون هناك حاجة إلى تعديل السرد أو التنسيق.', context.brand.languageMode),
      localizeTemplateText('3. Use the PPTX deck for presentation and stakeholder briefing.', '3. استخدم ملف PPTX للعروض التقديمية وإحاطة أصحاب المصلحة.', context.brand.languageMode),
      localizeTemplateText('4. Open 07_Digital_Portfolio/HTML_Website/index.html for the portfolio microsite.', '4. افتح 07_Digital_Portfolio/HTML_Website/index.html لعرض موقع المحفظة الرقمية.', context.brand.languageMode),
      localizeTemplateText('5. Review 04_Reports/Data_Excel/generated_outputs.xlsx for the full output inventory.', '5. راجع 04_Reports/Data_Excel/generated_outputs.xlsx للاطلاع على قائمة المخرجات كاملة.', context.brand.languageMode),
      localizeTemplateText('6. Review 08_Media/Videos for script-ready promotional content.', '6. راجع 08_Media/Videos للوصول إلى المحتوى الإعلامي الجاهز للنصوص.', context.brand.languageMode),
    ].join('\n'));

    buildPortfolioHtml(context, dossier, copiedAssets, portfolioHtmlPath);

    const generatedDeliverables = [
      { label: localizeTemplateText('Main Dossier (PDF)', 'الوثيقة الشاملة (PDF)', context.brand.languageMode), path: dossierPdfPath },
      { label: localizeTemplateText('Main Dossier (Word)', 'الوثيقة الشاملة (Word)', context.brand.languageMode), path: dossierWordPath },
      { label: localizeTemplateText('Project Summary (PPTX)', 'ملخص المشروع (PPTX)', context.brand.languageMode), path: projectPptPath },
      { label: localizeTemplateText('Digital Portfolio (HTML)', 'المحفظة الرقمية (HTML)', context.brand.languageMode), path: portfolioHtmlPath },
      { label: localizeTemplateText('Infographic (SVG)', 'الإنفوجرافيك (SVG)', context.brand.languageMode), path: infographicPaths.svgPath },
      { label: localizeTemplateText('Infographic (PNG)', 'الإنفوجرافيك (PNG)', context.brand.languageMode), path: infographicPaths.pngPath },
      { label: localizeTemplateText('Infographic (PDF)', 'الإنفوجرافيك (PDF)', context.brand.languageMode), path: infographicPaths.pdfPath },
      { label: localizeTemplateText('Promo Script', 'النص الترويجي', context.brand.languageMode), path: promoScriptPath },
      { label: localizeTemplateText('Social Captions', 'التعليقات الإعلامية', context.brand.languageMode), path: captionsPath },
      { label: localizeTemplateText('User Guide', 'دليل الاستخدام', context.brand.languageMode), path: userGuidePath },
      ...buildingOutputs,
    ].map(item => ({
      ...item,
      ext: fileExt(item.path).slice(1) || 'txt',
      relativePath: toWebPath(path.relative(packageRoot, item.path)),
    }));

    await buildExcelManifest(context, dossier, contentModel, generatedDeliverables, outputManifestPath);
    generatedDeliverables.push({
      label: localizeTemplateText('Generated Outputs Manifest (Excel)', 'فهرس المخرجات الناتجة (Excel)', context.brand.languageMode),
      path: outputManifestPath,
      ext: 'xlsx',
      relativePath: toWebPath(path.relative(packageRoot, outputManifestPath)),
    });

    const metadata = {
      jobId,
      service: 6,
      serviceName: SERVICE_06_NAME,
      serviceDefinition: SERVICE_06_DEFINITION,
      project: context.project,
      brand: context.brand,
      linkedJobs: dedupedJobs.map(job => ({
        jobId: job.jobId,
        sourceLabel: getNeutralSourceLabel(job, context.brand.languageMode),
        title: neutralizeServiceMentions(job.title, context.brand.languageMode),
      })),
      contentModel: {
        counts: contentModel.counts,
        byType: contentModel.byType,
        bySource: contentModel.bySource,
        buildings: Object.keys(contentModel.byBuilding),
        districts: Object.keys(contentModel.byDistrict),
      },
      dossier: {
        title: dossier.title,
        subtitle: dossier.subtitle,
        buildingDocuments: dossier.buildingRecords.map(building => building.name),
      },
      generatedAt: new Date().toISOString(),
      warnings: [
        neutralizeServiceMentions('This package fully handles local aggregation, indexing, folder packaging, PDF/Word/PPTX/HTML generation, infographics, and script-ready media support.', context.brand.languageMode),
        neutralizeServiceMentions('Rendered MP4 video generation, studio-grade voiceover synthesis, and advanced live 3D/map embedding beyond linked HTML assets would require additional runtime tooling or external APIs.', context.brand.languageMode),
      ],
    };

    fs.writeFileSync(metadataSummaryPath, JSON.stringify(metadata, null, 2));
    generatedDeliverables.push({
      label: localizeTemplateText('Package Manifest (JSON)', 'بيانات الحزمة (JSON)', context.brand.languageMode),
      path: metadataSummaryPath,
      ext: 'json',
      relativePath: toWebPath(path.relative(packageRoot, metadataSummaryPath)),
    });

    fs.writeFileSync(readmePath, buildReadmeText(context, dossier, generatedDeliverables, packageRootName));
    generatedDeliverables.push({
      label: localizeTemplateText('README', 'دليل الحزمة', context.brand.languageMode),
      path: readmePath,
      ext: 'txt',
      relativePath: toWebPath(path.relative(packageRoot, readmePath)),
    });

    const zipEntries = collectZipEntries(packageRoot);
    fs.writeFileSync(bundleZipPath, createStoredZip(zipEntries));

    const outputFiles = [
      ...generatedDeliverables.map(file => ({
        label: file.label,
        url: relOutputUrl(jobId, file.path),
        ext: file.ext,
      })),
      {
        label: localizeTemplateText('Delivery Bundle (ZIP)', 'حزمة التسليم (ZIP)', context.brand.languageMode),
        url: relOutputUrl(jobId, bundleZipPath),
        ext: 'zip',
      },
    ];

    const metaPath = path.join(jobDir, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, outputFiles }, null, 2));
    outputFiles.push({
      label: localizeTemplateText('Service 06 Metadata (JSON)', 'بيانات الخدمة 06 (JSON)', context.brand.languageMode),
      url: relOutputUrl(jobId, metaPath),
      ext: 'json',
    });

    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'done';
        jobRecord.outputFiles = outputFiles;
        jobRecord.completedAt = new Date();
        jobRecord.metadata = { ...metadata, outputFiles };
        await jobRecord.save();
      } catch (error) {
        // Ignore optional persistence failures.
      }
    }

    res.json({
      success: true,
      jobId,
      serviceName: SERVICE_06_NAME,
      provider: 'local-packaging',
      model: 'documentation-media-pipeline-v1',
      preview: buildResponsePreview(context, dossier, contentModel, outputFiles),
      outputFiles,
      packageRoot: `/outputs/${jobId}/${packageRootName}`,
      warnings: metadata.warnings,
    });
  } catch (error) {
    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'failed';
        jobRecord.error = error.message;
        await jobRecord.save();
      } catch (saveError) {
        // Ignore optional persistence failures.
      }
    }

    res.status(500).json({ error: error.message || 'Service 06 generation failed.' });
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
      const job = await Job.findOne({ jobId: req.params.jobId, service: 6 });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      return res.json(job);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(404).json({ error: 'Job not found' });
});

module.exports = router;
