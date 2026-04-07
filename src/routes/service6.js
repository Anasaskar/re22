'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

const { normalizeAiModel, getAiModelLabel } = require('../utils/aiModels');
const { generateStructuredJson } = require('../utils/aiTextProviders');
const { parseModelJsonObject } = require('../utils/structuredJson');

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
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const SERVICE_06_BOARD_IMAGE_MODEL = process.env.SERVICE_06_BOARD_IMAGE_MODEL
  || process.env.NANO_BANANA_IMAGE_MODEL
  || 'google/nano-banana-2:b7866a051519a43b5dda3ee54a3013c4813939a18af2b627f8f1dba876efd443';
const replicate = Replicate && REPLICATE_API_TOKEN ? new Replicate({ auth: REPLICATE_API_TOKEN }) : null;

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

function parseStructuredAiJson(text) {
  return parseModelJsonObject(text);
}

const UTF8_MOJIBAKE_RE = /[\u00C2\u00C3\u00D8\u00D9\u00E2\u00F0]/;
const DISPLAY_TEXT_SEQUENCE_REPLACEMENTS = [
  ['\u0641\u201A', '\u0642'],
  ['\u0641\u2021', '\u0647'],
  ['\u0641\u2030', '\u0649'],
  ['\u0641\u0192', '\u0643'],
  ['\u0641\u2018', '\u0651'],
  ['\u0627\u0641\u2039', '\u0627\u064B'],
  ['\u0641\u017D', ''],
  ['\u00D8\u203A', '\u061B'],
];
const DISPLAY_TEXT_WORD_REPLACEMENTS = [
  [/\u0628\u0635\u0631\u064A\u0629\u064A\b/g, '\u0628\u0635\u0631\u064A\u0629'],
  [/\u0645\u062E\u0635\u0635\u0629\u064A\b/g, '\u0645\u062E\u0635\u0635\u0629'],
  [/\u0645\u0643\u0627\u0646\u064A\u0629\u064A\b/g, '\u0645\u0643\u0627\u0646\u064A\u0629'],
  [/\u0645\u0631\u062A\u0628\u0637\u0629\u064A\b/g, '\u0645\u0631\u062A\u0628\u0637\u0629'],
  [/\u0643\u0627\u0645\u0644\u0629\u064A\b/g, '\u0643\u0627\u0645\u0644\u0629'],
  [/\u0627\u0644\u0645\u0631\u062C\u0639\u064A\u0629\u064A\b/g, '\u0627\u0644\u0645\u0631\u062C\u0639\u064A\u0629'],
  [/\u0627\u0644\u0623\u062F\u0644\u0629\u064A\b/g, '\u0627\u0644\u0623\u062F\u0644\u0629'],
  [/\u0641\u0639\u0644\u064A\u0627\u064A/g, '\u0641\u0639\u0644\u064A\u0627'],
  [/\u0641\u0642\u0637\u064A/g, '\u0641\u0642\u0637'],
  [/\u0627\u0644\u0628\u0635\u0631\u064A\u064A/g, '\u0627\u0644\u0628\u0635\u0631\u064A'],
  [/\u0647\u0627\u0627\u064A/g, '\u0647\u0627'],
];
const DISPLAY_TEXT_SYMBOL_REPLACEMENTS = [
  [/\u2013|\u2014/g, ' - '],
  [/\u2026/g, '...'],
  [/\uD83D\uDCD0|\uD83D\uDCC4/g, '-'],
];

function decodeUtf8Mojibake(value = '') {
  let text = String(value || '');
  for (let index = 0; index < 2; index += 1) {
    if (!UTF8_MOJIBAKE_RE.test(text)) break;
    const decoded = Buffer.from(text, 'latin1').toString('utf8');
    if (!decoded || decoded === text || decoded.includes('\uFFFD')) break;
    text = decoded;
  }
  return text;
}

function repairDisplayText(value = '') {
  let text = decodeUtf8Mojibake(value);

  DISPLAY_TEXT_SEQUENCE_REPLACEMENTS.forEach(([from, to]) => {
    text = text.split(from).join(to);
  });
  DISPLAY_TEXT_WORD_REPLACEMENTS.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  DISPLAY_TEXT_SYMBOL_REPLACEMENTS.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });

  return text;
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

const EXPORT_PREFERENCE_ALIASES = {
  pdf: 'pdf',
  word: 'word',
  doc: 'word',
  docx: 'word',
  ppt: 'pptx',
  pptx: 'pptx',
  powerpoint: 'pptx',
  html: 'html',
  htm: 'html',
  xls: 'xlsx',
  xlsx: 'xlsx',
  excel: 'xlsx',
  zip: 'zip',
  archive: 'zip',
};

function normalizeExportPreferences(value) {
  const selected = Array.isArray(value) ? value : parseCsvList(value);
  const normalized = new Set();

  selected.forEach(item => {
    const key = EXPORT_PREFERENCE_ALIASES[normalizeText(item).toLowerCase()];
    if (key) normalized.add(key);
  });

  if (!normalized.size) {
    ['pdf', 'word', 'pptx', 'html', 'xlsx', 'zip'].forEach(key => normalized.add(key));
  }

  return normalized;
}

function getDeliverableExportFamily(deliverable = {}) {
  const ext = normalizeText(deliverable.ext || fileExt(deliverable.path).slice(1)).toLowerCase();
  const label = normalizeText(deliverable.label).toLowerCase();

  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'word';
  if (ext === 'ppt' || ext === 'pptx') return 'pptx';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'xls' || ext === 'xlsx') return 'xlsx';
  if (ext === 'zip') return 'zip';
  if (ext === 'png' && label.includes('board')) return 'pptx';
  return null;
}

function isDeliverableSelected(deliverable, selectedExports) {
  const family = getDeliverableExportFamily(deliverable);
  return family ? selectedExports.has(family) : false;
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
  const englishText = repairDisplayText(english);
  const arabicText = repairDisplayText(arabic);
  if (language === 'arabic') return arabicText;
  if (language === 'bilingual') return `${arabicText} / ${englishText}`;
  return englishText;
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

  return repairDisplayText(text.replace(/\s{2,}/g, ' ').trim());
}

function localizeTemplateText(english, arabic, mode = 'english') {
  const language = normalizeText(mode, 'english').toLowerCase();
  const englishText = repairDisplayText(english);
  const arabicText = repairDisplayText(arabic);
  if (language === 'arabic') return arabicText;
  if (language === 'bilingual') return `${arabicText}\n\n${englishText}`;
  return englishText;
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
  const beforeCount = doc.bufferedPageRange().count;
  const beforeLengths = Array.from({ length: beforeCount }, (_, index) =>
    doc?._pageBuffer?.[index]?.content?.uncompressedLength || 0,
  );
  writer();
  const afterCount = doc.bufferedPageRange().count;
  const end = Math.max(beforeCount, afterCount);
  for (let index = 0; index < end; index += 1) {
    const beforeLength = beforeLengths[index] || 0;
    const afterLength = doc?._pageBuffer?.[index]?.content?.uncompressedLength || 0;
    if (afterLength > beforeLength) onPageUsed(index);
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

function trimBufferedPages(doc, pageIndexes = new Set()) {
  const range = doc.bufferedPageRange();
  const blankPageThreshold = 24;
  const candidateIndexes = (pageIndexes.size
    ? Array.from(pageIndexes).sort((a, b) => a - b)
    : Array.from({ length: range.count }, (_, index) => index))
    .filter(index => index >= 0 && index < range.count);
  const keepIndexes = candidateIndexes.filter(index =>
    (doc?._pageBuffer?.[index]?.content?.uncompressedLength || 0) > blankPageThreshold,
  );

  if (!keepIndexes.length) keepIndexes.push(0);

  if (Array.isArray(doc._pageBuffer)) {
    doc._pageBuffer = keepIndexes.map(index => doc._pageBuffer[index]).filter(Boolean);
    doc._pageBufferStart = 0;

    const pages = doc?._root?.data?.Pages?.data;
    if (pages && Array.isArray(pages.Kids)) {
      pages.Kids = keepIndexes.map(index => pages.Kids[index]).filter(Boolean);
      pages.Count = pages.Kids.length;
    }

    doc.switchToPage(Math.max(0, keepIndexes.length - 1));
  }

  return keepIndexes.length;
}

function formatPdfRtlLine(line = '') {
  const tokens = String(line)
    .split(/(\s+)/)
    .filter(token => token.length > 0);

  return tokens.reverse().join('');
}

function formatPdfText(value = '', language = 'english') {
  const text = repairDisplayText(value);
  const rtlLike = language === 'arabic' || language === 'bilingual';
  if (!rtlLike) return text;

  return text
    .split('\n')
    .map(line => (containsArabic(line) ? formatPdfRtlLine(line) : line))
    .join('\n');
}

function localizedAssetType(type, mode = 'english') {
  return labelForLanguage(type, ({
    image: 'صورة',
    model: 'نماذج',
    'map-data': 'بيانات خرائط',
    metadata: 'بيانات وصفية',
    drawing: 'رسوم تقنية',
    report: 'تقارير',
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
  const text = repairDisplayText(value);
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
    `يوثق ${name} من خلال ${assets.length} ملف مرتبط مستمد من ${relatedSources.join('، ') || 'المصادر المتاحة'}. ويشمل السجل الحالي ${typeMix || 'ملفات مساندة للمشروع'}. ${hasVisuals ? 'تتوفر أدلة بصرية ضمن هذا السجل.' : 'الأدلة البصرية ضمن هذا السجل محدودة.'} ${hasModels ? 'كما تتوفر مواد ثلاثية الأبعاد أو تفاعلية.' : ''} ${limitationLine}`,
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
    languageMode: normalizeText(input.languageMode, 'arabic').toLowerCase() === 'english' ? 'english' : 'arabic',
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
  const inheritedAiModel = normalizeAiModel(
    input.aiModel
      || service4?.metadata?.reportProfile?.aiModel
      || service4?.metadata?.reportProfile?.aiModelKey
      || service4?.metadata?.textGeneration?.aiModel
      || service4?.metadata?.textGeneration?.aiModelKey
      || 'gpt',
    'gpt',
  );

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
    ai: {
      model: inheritedAiModel,
      modelLabel: getAiModelLabel(inheritedAiModel, 'gpt'),
    },
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
        `يجمع ملف ${name} عدد ${assets.length} من الملفات من ${relatedSources.join('، ') || 'حزمة المصادر المرتبطة بالمشروع'}.`,
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
      title: labelForLanguage('Front Matter', 'المقدمة', languageMode),
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
        `يجمع ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من ملفات المخرجات من ${totalJobs} مهة مرتبطة ضمن مراحل المشروع المختلطة. وقد تم تنظيم الحزمة لأغراض التوثيق والعرض والنشر والمراجعة والتسليم الرقمي.`,
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
          'يُف‚رأ السياف‚ التاريخي والجغرافي بالتوازي مع التف‚ارير والخرائط المرتبطة والمضمنة في ف‡ذف‡ الحزمة. وتحافظ البنية الحالية علف‰ المواد المرجعية المتاحة وتفف‡رسف‡ا حتف‰ عند محدودية البيانات السردية المنظمة.',
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
          `تشمل المخرجات العمرانية مخططات النطاقي وبيانات جغرافية مفƒانيةي وخرائط تحليليةي ومواد تفاعلية للمحفظة الرف‚مية. ويشمل نطاف‚ التغطية العمرانية: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          languageMode,
        )
        : localizeTemplateText(
          'Urban analysis assets were not explicitly linked, but the dossier structure reserves a dedicated section so district-scale materials can be integrated consistently when present.',
          'لم يتم ربط مواد التحليل العمراني بشفƒل صريحي إلا أن بنية الوثيف‚ة تحتفظ بف‚سم مخصص لف‡ا بحيث يمكن دمج مواد النطاق العمراني بشفƒل متسف‚ عند توفرف‡ا.',
          languageMode,
        ),
    },
    {
      id: 'standards_compliance',
      title: labelForLanguage('Standards and Compliance Analysis', 'تحليل المعايير والامتثال', languageMode),
      body: service4
        ? localizeTemplateText(
          'Linked standards-oriented report outputs are integrated as supporting evidence for references, methodology, and compliance-oriented communication.',
          'تم دمج المخرجات المرتبطة ذات الصلة بالمعايير باعتبارف‡ا أدلة مساندة للمراجع والمنف‡جية والصياغة الموجف‡ة للامتثال.',
          languageMode,
        )
        : localizeTemplateText(
          'This package provides placeholders and structured appendices for standards and compliance analysis; richer narrative interpretation can be layered from linked reports or external policy review when required.',
          'توفر ف‡ذف‡ الحزمة مواضع مف‡يفƒلة وملاحف‚ منظمة لتحليل المعايير والامتثالي ويمكن إثراؤف‡ا لاحف‚اف‹ بسرد أفƒثر عمف‚اف‹ اعتماداف‹ علف‰ التف‚ارير المرتبطة أو المراجعات التنظيمية الخارجية عند الحاجة.',
          languageMode,
        ),
    },
    {
      id: 'implementation_plan',
      title: labelForLanguage('Implementation Plan', 'خطة التنفيذ', languageMode),
      body: localizeTemplateText(
        'The delivery package separates source imagery, technical drawings, 3D models, reports, presentations, dossier outputs, digital portfolio files, and media assets into a controlled handover structure. This supports phased review, printing, presentation, and downstream refinement.',
        'تفصل حزمة التسليم بين الصور المرجعيةي والرسومات التف‚نيةي والنماذج ثلاثية الأبعادي والتف‚اريري والعروض التف‚ديميةي ومخرجات الوثيف‚ة الشاملةي وملفات المحفظة الرف‚ميةي والمواد الإعلامية ضمن هيكل تسليم منظم. ويدعم ذلفƒ المراجعة المرحلية والطباعة والعرض والتطوير اللاحف‚.',
        languageMode,
      ),
    },
    {
      id: 'conclusion',
      title: labelForLanguage('Conclusion', 'الخاتمة', languageMode),
      body: localizeTemplateText(
        `This documentation and media package transforms technical project outputs into a communication-ready documentation set with clear branding, delivery indexing, reusable building templates, and digital-ready presentation outputs. Current file-type coverage: ${typeSummary}.`,
        `تحول ف‡ذف‡ الحزمة التوثيف‚ية والإعلامية مخرجات المشروع التف‚نية إلف‰ مجموعة توثيف‚ية جاف‡زة للتواصل والعرض بف‡وية واضحة وفف‡رسة للتسليم وف‚والب ف‚ابلة لإعادة الاستخدام للمباني ومخرجات مناسبة للعروض الرف‚مية. ويشمل نطاف‚ أنواع الملفات الحالية: ${typeSummary}.`,
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
        'تم إدراج المشاف‡د التفاعلية ومخرجات الرندرة ضمن طبف‚ات الوسائط والمحفظة الرف‚مية.',
        languageMode,
      ),
    });
  }

  return {
    title: labelForLanguage('Comprehensive Project Dossier', 'الوثيف‚ة التوثيف‚ية الشاملة للمشروع', languageMode),
    subtitle: context.brand.projectName,
    executiveSummary: localizeTemplateText(
      `${context.brand.projectName} consolidates ${contentModel.counts.totalAssets} indexed assets into a professional communication package that includes a comprehensive dossier, building-level documents, media-ready outputs, a digital portfolio, and delivery manifests.`,
      `يوحف‘د ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من الأصول المفف‡رسة ضمن حزمة تواصل مف‡نية تشمل وثيف‚ة شاملة للمشروعي ووثائف‚ علف‰ مستوف‰ المبانيي ومخرجات إعلامية جاف‡زةي ومحفظة رف‚ميةي وملفات تسليم منظمة.`,
      languageMode,
    ),
    methodology: localizeTemplateText(
      'The documentation and media pipeline collects linked project outputs, classifies files by building, district, type, and usage, applies the selected project identity, and generates structured exports for print, presentation, and digital delivery.',
      'تجمع منظومة التوثيف‚ والإخراج الإعلامي مخرجات المشروع المرتبطةي وتُصنف‘ِف الملفات حسب المبنف‰ والنطاق والنوع والاستخدامي وتطبف‚ الف‡وية المختارة للمشروعي ثم تولد مخرجات منظمة للطباعة والعرض والتسليم الرف‚مي.',
      languageMode,
    ),
    buildingRecords,
    sections,
    references,
    appendices: [
      localizeTemplateText('Asset register and output manifest', 'سجل الأصول وفف‡رس المخرجات', languageMode),
      localizeTemplateText('Packaging manifest and delivery README', 'بيانات الحزمة وملف تعليمات التسليم', languageMode),
      localizeTemplateText('Building document list', 'ف‚ائمة وثائف‚ المباني', languageMode),
      localizeTemplateText('Digital portfolio index', 'فف‡رس المحفظة الرف‚مية', languageMode),
      localizeTemplateText('Media script and captions pack', 'حزمة النصوص الإعلامية والتعليف‚ات', languageMode),
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
        'لم ترد أسماء مبان مستف‚لة ضمن البيانات المدخلةي لذلفƒ سيجري تجميع سجل مبنف‰ عام علف‰ مستوف‰ المشروع من المواد المرتبطة المتاحة. ويجب ف‚راءة ف‡ذا الملف بوصفف‡ فصلا عاما للمشروع الفƒامل لا جدولا مفصلا لمبان منفصلة.',
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
        `تتوفر مراجع بصريةي ويشمل ذلفƒ ${coverage.visualCount} أصلا بصريا يدعم المراجعة والعرض والمف‚ارنة.`,
        languageMode,
      )
      : localizeTemplateText(
        'No dedicated visual reference set was linked, so visual interpretation remains limited to the files packaged directly within this delivery.',
        'لم يتم ربط مجموعة مراجع بصرية مخصصةي لذلفƒ يبف‚ف‰ التفسير البصري مف‚يدا بالملفات المضافة مباشرة داخل ف‡ذف‡ الحزمة.',
        languageMode,
      ),
    coverage.hasUrbanAnalysis
      ? localizeTemplateText(
        `Urban and geographic material is present through ${coverage.mapCount} map or spatial dataset(s), allowing the dossier to anchor the project within its broader setting.`,
        `تتوفر مواد عمرانية وجغرافية من خلال ${coverage.mapCount} من الخرائط أو البيانات المفƒانيةي بما يسمح بربط المشروع بسياف‚ف‡ الأوسع.`,
        languageMode,
      )
      : localizeTemplateText(
        'District-scale and geographic analysis was not explicitly linked, so the dossier records only the available site-level evidence and states that limitation transparently.',
        'لم يتم ربط تحليل جغرافي أو عمراني علف‰ مستوف‰ النطاق بشفƒل صريحي لذلفƒ تسجل الوثيف‚ة الأدلة المتاحة علف‰ مستوف‰ الموف‚ع فف‚ط مع بيان ف‡ذا الف‚يد بوضوح.',
        languageMode,
      ),
    coverage.hasStructuredReporting
      ? localizeTemplateText(
        `Narrative and analytical reporting is available through ${coverage.reportCount} report file(s), enabling stronger methodological and reference framing.`,
        `يتوفر سرد وتحليل من خلال ${coverage.reportCount} ملف تف‚ريري ما يدعم صياغة منف‡جية ومرجعية أوضح.`,
        languageMode,
      )
      : localizeTemplateText(
        'Structured narrative reporting was not linked in full, therefore the dossier avoids overstating completeness and limits interpretation to the indexed evidence.',
        'لم يتم ربط تف‚ارير سردية منظمة بصورة فƒاملةي ولذلفƒ تتجنب الوثيف‚ة المبالغة في افƒتمال المشروع وتحصر التفسير في الأدلة المفف‡رسة المتاحة.',
        languageMode,
      ),
    coverage.hasThreeDimensionalOutputs
      ? localizeTemplateText(
        `Three-dimensional and interactive content is available through ${coverage.modelCount} model file(s) and ${coverage.interactiveCount} interactive output(s), supporting presentation and design communication.`,
        `تتوفر مواد ثلاثية الأبعاد وتفاعلية من خلال ${coverage.modelCount} ملف نموذج و${coverage.interactiveCount} مخرجا تفاعلياي بما يدعم العرض والتواصل التصميمي.`,
        languageMode,
      )
      : localizeTemplateText(
        'No linked three-dimensional package was detected, so the dossier remains focused on documentation and indexed deliverables rather than immersive presentation material.',
        'لم يتم رصد حزمة ثلاثية الأبعاد مرتبطةي لذلفƒ تظل الوثيف‚ة مرفƒزة علف‰ التوثيف‚ والمخرجات المفف‡رسة بدلا من المواد الغامرة الخاصة بالعرض.',
        languageMode,
      ),
  ].join('\n\n');

  const sections = [
    {
      id: 'project_overview',
      title: labelForLanguage('Project Overview', 'نظرة عامة علف‰ المشروع', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} was prepared for ${context.brand.implementingBody} as a final documentation dossier dated ${context.brand.preparationDate}. The package brings together ${contentModel.counts.totalAssets} indexed asset(s) from ${totalJobs} linked source package(s), while preserving the submitted project identity exactly as entered.`,
        `أُعد ${context.brand.projectName} لصالح ${context.brand.implementingBody} بوصفف‡ وثيف‚ة توثيف‚ نف‡ائية بتاريخ ${context.brand.preparationDate}. وتجمع الحزمة ${contentModel.counts.totalAssets} أصلا مفف‡رسا من ${totalJobs} حزمة مصدر مرتبطةي مع الحفاظ علف‰ ف‡وية المشروع المدخلة فƒما وردت تماما.`,
        languageMode,
      ),
    },
    {
      id: 'documentation_scope',
      title: labelForLanguage('Documentation Scope and Evidence Base', 'نطاف‚ التوثيف‚ وف‚اعدة الأدلة', languageMode),
      body: coverageNarrative,
    },
    {
      id: 'historical_context',
      title: labelForLanguage('Historical and Geographic Context', 'السياف‚ التاريخي والجغرافي', languageMode),
      body: service3
        ? localizeTemplateText(
          `${normalizeText(service3.metadata?.districtName, 'The project area')} in ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'the referenced location')} is documented through linked district-scale analysis, spatial datasets, and contextual mapping. These materials allow the dossier to position the project within its urban setting rather than describing the property in isolation.\n\nWhere district metadata is partial, the dossier keeps the interpretation conservative and relies only on verifiable linked evidence.`,
          `يوثف‚ ${normalizeText(service3.metadata?.districtName, 'منطف‚ة المشروع')} في ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'الموف‚ع المرجعي')} من خلال تحليل مرتبط علف‰ مستوف‰ النطاق وبيانات مفƒانية وخرائط سياف‚ية. وتتيح ف‡ذف‡ المواد وضع المشروع داخل إطارف‡ العمراني بدلا من وصفف‡ بمعزل عن محيطف‡.\n\nوعند جزئية بيانات النطاق أو عدم افƒتمالف‡اي تحافظ الوثيف‚ة علف‰ صياغة متحفظة وتستند فف‚ط إلف‰ الأدلة المرتبطة الف‚ابلة للتحف‚ف‚.`,
          languageMode,
        )
        : localizeTemplateText(
          'No linked district-scale context package was provided. Accordingly, this dossier records the project location and the boundaries of the available evidence without claiming a complete historical or geographic interpretation.\n\nAdditional contextual analysis can be incorporated later when verified urban or historical reference material is linked.',
          'لم يتم توفير حزمة سياف‚ مرتبطة علف‰ مستوف‰ النطاق. وبناء علف‰ ذلفƒي تفƒتفي ف‡ذف‡ الوثيف‚ة بتسجيل موف‚ع المشروع وحدود الأدلة المتاحة دون الادعاء بوجود تفسير تاريخي أو جغرافي مفƒتمل.\n\nويمكن لاحف‚ا دمج تحليل سياف‚ي إضافي عند ربط مواد عمرانية أو تاريخية موثف‚ة.',
          languageMode,
        ),
    },
    {
      id: 'building_chapters',
      title: labelForLanguage('Building Documentation Sections', 'أف‚سام توثيف‚ المباني', languageMode),
      body: localizeTemplateText(
        `Building-level documentation has been prepared for ${buildingRecords.length} building group(s). Each section consolidates the evidence currently available for that building and avoids assuming documentation depth that was not actually linked.\n\nThe emphasis is on producing readable final documentation chapters rather than an asset index alone.`,
        `أُعد توثيف‚ علف‰ مستوف‰ المباني لعدد ${buildingRecords.length} مجموعة مبان. ويجمع كل ف‚سم الأدلة المتاحة فعليا لذلفƒ المبنف‰ دون افتراض عمف‚ توثيف‚ي لم يتم ربطف‡ بالفعل.\n\nوينصب الترفƒيز ف‡نا علف‰ إنتاج فصول توثيف‚ نف‡ائية ف‚ابلة للف‚راءة لا مجرد فف‡رس للأصول.`,
        languageMode,
      ),
    },
    {
      id: 'urban_analysis',
      title: labelForLanguage('Urban Fabric and Spatial Reading', 'تحليل النسيج العمراني والف‚راءة المفƒانية', languageMode),
      body: service3
        ? localizeTemplateText(
          `The linked spatial set includes plans, geospatial datasets, analytical mapping, and interactive material. These outputs strengthen the dossier by connecting the project to access patterns, district structure, and surrounding urban relationships.\n\nAvailable district notes: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          `تتضمن المجموعة المفƒانية المرتبطة مخططات وبيانات جغرافية مفƒانية وخرائط تحليلية ومواد تفاعلية. وتعزز ف‡ذف‡ المخرجات الوثيف‚ة من خلال ربط المشروع بأنماط الوصول وبنية النطاق والعلاف‚ات العمرانية المحيطة.\n\nالملاحظات المتاحة عن النطاق: ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`,
          languageMode,
        )
        : localizeTemplateText(
          'Urban analysis material was not linked. This section therefore records the gap explicitly and keeps the final dossier limited to building-level and project-level evidence that is actually available.',
          'لم يتم ربط مواد تحليل عمراني. ولذلفƒ يسجل ف‡ذا الف‚سم الفجوة بصورة صريحة ويف‚صر الوثيف‚ة النف‡ائية علف‰ الأدلة المتاحة فعليا علف‰ مستوف‰ المبنف‰ والمشروع.',
          languageMode,
        ),
    },
    {
      id: 'standards_compliance',
      title: labelForLanguage('Standards and Compliance', 'المعايير والامتثال', languageMode),
      body: service4
        ? localizeTemplateText(
          'Linked analytical reporting supports this dossier as reference evidence for standards, methodology, and review requirements. The section is framed as a documentation aid and does not claim regulatory closure unless such closure is explicitly evidenced in the linked material.',
          'تدعم التف‚ارير التحليلية المرتبطة ف‡ذف‡ الوثيف‚ة بوصفف‡ا أدلة مرجعية تتصل بالمعايير والمنف‡جية ومتطلبات المراجعة. ويعرض ف‡ذا الف‚سم باعتبارف‡ أداة توثيف‚ية مساندة ولا يدعي الحسم التنظيمي إلا إذا فƒان ذلفƒ مثبتا صراحة في المواد المرتبطة.',
          languageMode,
        )
        : localizeTemplateText(
          'No dedicated compliance-oriented report was linked. The dossier therefore limits this chapter to documentation notes, reference placeholders, and a clear statement that additional review material would be required for any formal compliance claim.',
          'لم يتم ربط تف‚رير مخصص للامتثال. لذلفƒ يف‚تصر ف‡ذا الفصل علف‰ ملاحظات توثيف‚ية ومواضع مرجعية وبيان واضح بأن أي ادعاء رسمي بالامتثال يحتاج إلف‰ مواد مراجعة إضافية.',
          languageMode,
        ),
    },
    {
      id: 'implementation_notes',
      title: labelForLanguage('Implementation Notes', 'ملاحظات التنفيذ', languageMode),
      body: localizeTemplateText(
        `The final package has been arranged for formal review and downstream use across print, presentation, and digital delivery. Available material has been separated into dossier files, building records, media assets, and structured manifests so the package can be navigated without losing the relationship to its source evidence.\n\nCurrent file-type coverage: ${typeSummary}.`,
        `رُتبت الحزمة النف‡ائية لتناسب المراجعة الرسمية والاستخدام اللاحف‚ عبر الطباعة والعرض والتسليم الرف‚مي. وفصلت المواد المتاحة إلف‰ ملفات وثيف‚ة رئيسية وسجلات مبان ومواد إعلامية وفف‡ارس منظمة حتف‰ يسف‡ل التنف‚ل داخل الحزمة من دون فف‚دان الصلة بأدلتف‡ا المرجعية.\n\nويشمل نطاف‚ أنواع الملفات الحالية: ${typeSummary}.`,
        languageMode,
      ),
    },
    {
      id: 'conclusion',
      title: labelForLanguage('Conclusion', 'الخاتمة', languageMode),
      body: localizeTemplateText(
        `${context.brand.projectName} is presented here as a polished documentation deliverable built from real linked content, not as a claim of completeness beyond the evidence supplied. Where source packages were missing, the dossier states that limitation directly; where evidence was available, it has been organized into a coherent final record fit for review and presentation.`,
        `يف‚دم ${context.brand.projectName} ف‡نا بوصفف‡ مخرجا توثيف‚يا مصف‚ولا مبنيا علف‰ محتوف‰ مرتبط فعلياي لا باعتبارف‡ ادعاء بافƒتمال يتجاوز الأدلة المف‚دمة. وحيث غابت بعض الحزم المرجعيةي تذفƒر الوثيف‚ة ف‡ذا الف‚يد مباشرةØ› وحيث توفرت الأدلةي فف‚د نظمت في سجل نف‡ائي متماسفƒ صالح للمراجعة والعرض.`,
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
        'أدرجت المشاف‡د التفاعلية والمخرجات المرئية المعالجة حيثما توفرت.',
        languageMode,
      ),
    });
  }

  return {
    title: labelForLanguage('Comprehensive Project Dossier', 'الوثيف‚ة التوثيف‚ية الشاملة للمشروع', languageMode),
    subtitle: context.brand.projectName,
    executiveSummary: localizeTemplateText(
      `${context.brand.projectName} consolidates ${contentModel.counts.totalAssets} indexed asset(s) into a polished final documentation package centered on a comprehensive dossier, building-level records, and presentation-ready outputs. The narrative is based on real linked evidence only, with missing source areas identified clearly rather than inferred.`,
      `يوحد ${context.brand.projectName} عدد ${contentModel.counts.totalAssets} من الأصول المفف‡رسة ضمن حزمة توثيف‚ نف‡ائية مصف‚ولة تتمحور حول وثيف‚ة شاملة وسجلات علف‰ مستوف‰ المباني ومخرجات جاف‡زة للعرض. ويستند السرد إلف‰ الأدلة المرتبطة الفعلية فف‚طي مع بيان مجالات النف‚ص بوضوح بدلا من افتراضف‡ا.`,
      languageMode,
    ),
    methodology: localizeTemplateText(
      'The export pipeline assembles linked project materials, classifies them by building, district, source, type, and usage, then renders a unified dossier and companion outputs using language-aware formatting rules. Arabic rendering, RTL direction, and mixed-language handling are treated as export requirements rather than optional styling.',
      'تجمع منظومة التصدير مواد المشروع المرتبطة وتصنفف‡ا حسب المبنف‰ والنطاق والمصدر والنوع والاستخدامي ثم تنتج وثيف‚ة موحدة ومخرجات مساندة باستخدام ف‚واعد تنسيف‚ واعية باللغة. وتعامل سلامة العربية واتجاف‡ اليمين إلف‰ اليسار ومعالجة النصوص المختلطة علف‰ أنف‡ا متطلبات تصدير أساسية لا مجرد تحسينات شفƒلية.',
      languageMode,
    ),
    coverage,
    buildingRecords,
    sections,
    references,
    appendices: [
      localizeTemplateText('Asset register and generated output manifest', 'سجل الأصول وفف‡رس المخرجات الناتجة', languageMode),
      localizeTemplateText('Packaging manifest and delivery guidance', 'بيانات الحزمة وإرشادات التسليم', languageMode),
      localizeTemplateText('Building record list', 'ف‚ائمة سجلات المباني', languageMode),
      localizeTemplateText('Digital portfolio index', 'فف‡رس المحفظة الرف‚مية', languageMode),
      localizeTemplateText('Media script and caption set', 'حزمة النصوص الإعلامية والتعليف‚ات', languageMode),
    ],
  };
}

const SERVICE_06_NARRATIVE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['executiveSummary', 'methodology', 'sections', 'buildingRecords', 'appendices', 'promoScript', 'socialCaptions'],
  properties: {
    executiveSummary: { type: 'string' },
    methodology: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'body'],
        properties: {
          id: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    buildingRecords: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'summary'],
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    appendices: {
      type: 'array',
      items: { type: 'string' },
    },
    promoScript: { type: 'string' },
    socialCaptions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};
const SERVICE_06_TEXT_MODEL_OVERRIDES = {
  gpt: process.env.SERVICE_06_OPENAI_MODEL || process.env.OPENAI_REPORT_MODEL || 'openai/gpt-5-structured',
  gemini: process.env.SERVICE_06_GEMINI_MODEL || process.env.GEMINI_REPORT_MODEL || 'google/gemini-3.1-pro',
  claude: process.env.SERVICE_06_CLAUDE_MODEL || process.env.CLAUDE_REPORT_MODEL || 'anthropic/claude-4.5-sonnet',
};

function buildDossierNarrativePromptBundle(context, linkedJobs, contentModel, dossier) {
  const languageMode = context.brand.languageMode;
  const languageInstruction = languageMode === 'arabic'
    ? 'Write all narrative text in Arabic only. Do not switch to English except for unavoidable proper names already supplied in the inputs.'
    : 'Write all narrative text in English only. Do not include Arabic script in the generated narrative.';

  const contextForModel = {
    aiModel: context.ai.modelLabel,
    project: context.project,
    brand: {
      projectName: context.brand.projectName,
      implementingBody: context.brand.implementingBody,
      preparationDate: context.brand.preparationDate,
      consultantTeam: context.brand.consultantTeam,
      languageMode: context.brand.languageMode,
    },
    counts: contentModel.counts,
    linkedSources: linkedJobs.map(job => ({
      title: neutralizeServiceMentions(job.title, languageMode),
      service: job.serviceName,
      jobId: job.jobId,
    })),
    buildingRecords: dossier.buildingRecords.map(building => ({
      name: building.name,
      summary: building.summary,
      assetCount: Array.isArray(building.assets) ? building.assets.length : 0,
    })),
    sections: dossier.sections.map(section => ({
      id: section.id,
      title: section.title,
      body: section.body,
    })),
    appendices: dossier.appendices,
    notes: context.project.notes,
  };

  const systemPrompt = [
    'You are an architectural documentation writer producing polished dossier narrative for client-facing and academic-ready heritage presentation packages.',
    'Preserve the supplied project identity, building names, locations, and evidence boundaries exactly.',
    'Do not invent new buildings, dimensions, approvals, or historical claims.',
    'Do not mention internal service numbers, software workflow details, or implementation internals.',
    'Improve clarity, cohesion, and professional tone while staying faithful to the supplied draft structure.',
    languageInstruction,
    'Return valid JSON only.',
    'Do not wrap the JSON in markdown fences.',
    'Do not include comments, trailing commas, or explanatory text.',
    'Use double-quoted JSON strings and ensure every array element is comma-separated.',
  ].join(' ');

  const userPrompt = [
    'Rewrite and enrich the dossier narrative while preserving the existing structure and evidence boundaries.',
    'The selected AI model must influence executive summary tone, methodology wording, section prose, building summaries, captions, and presentation-supporting narrative.',
    'Keep the writing concise, professional, and presentation-ready rather than overly academic unless the source context requires it.',
    'Return only this JSON shape:',
    JSON.stringify({
      executiveSummary: 'string',
      methodology: 'string',
      sections: [{ id: 'string', body: 'string' }],
      buildingRecords: [{ name: 'string', summary: 'string' }],
      appendices: ['string'],
      promoScript: 'string',
      socialCaptions: ['string'],
    }, null, 2),
    'Source dossier context:',
    JSON.stringify(contextForModel, null, 2),
  ].join('\n\n');

  return { systemPrompt, userPrompt };
}

function applyNarrativeBundleToDossier(dossier, narrativeBundle) {
  const sectionMap = new Map(
    (Array.isArray(narrativeBundle?.sections) ? narrativeBundle.sections : [])
      .map(item => [normalizeText(item?.id).toLowerCase(), item])
      .filter(([key]) => key)
  );
  const buildingMap = new Map(
    (Array.isArray(narrativeBundle?.buildingRecords) ? narrativeBundle.buildingRecords : [])
      .map(item => [normalizeText(item?.name).toLowerCase(), item])
      .filter(([key]) => key)
  );
  const appendices = Array.isArray(narrativeBundle?.appendices)
    ? narrativeBundle.appendices.map(item => normalizeText(item)).filter(Boolean)
    : [];

  return {
    ...dossier,
    executiveSummary: normalizeMultiline(narrativeBundle?.executiveSummary, dossier.executiveSummary),
    methodology: normalizeMultiline(narrativeBundle?.methodology, dossier.methodology),
    sections: dossier.sections.map(section => {
      const override = sectionMap.get(normalizeText(section.id).toLowerCase());
      return {
        ...section,
        body: normalizeMultiline(override?.body, section.body),
      };
    }),
    buildingRecords: dossier.buildingRecords.map(building => {
      const override = buildingMap.get(normalizeText(building.name).toLowerCase());
      return {
        ...building,
        summary: normalizeMultiline(override?.summary, building.summary),
      };
    }),
    appendices: appendices.length ? appendices : dossier.appendices,
  };
}

async function synthesizeDossierNarrative(context, linkedJobs, contentModel, dossier) {
  const { systemPrompt, userPrompt } = buildDossierNarrativePromptBundle(context, linkedJobs, contentModel, dossier);
  const result = await generateStructuredJson({
    aiModel: context.ai.model,
    systemPrompt,
    userPrompt,
    parseJson: parseStructuredAiJson,
    modelOverrides: SERVICE_06_TEXT_MODEL_OVERRIDES,
    temperature: 0.3,
    maxTokens: 5000,
    timeoutMs: 180000,
    jsonSchema: SERVICE_06_NARRATIVE_JSON_SCHEMA,
  });

  return {
    selectedModel: context.ai.model,
    selectedLabel: context.ai.modelLabel,
    provider: result.provider,
    model: result.model,
    narrative: result.json,
    warnings: [],
  };
}

function buildReadmeText(context, dossier, outputFiles, packageRootName) {
  const includedFamilies = normalizeExportPreferences(outputFiles.map(file => file.ext));
  const lines = [
    `${context.brand.projectName}`,
    `${SERVICE_06_NAME}`,
    '',
    localizeTemplateText(`Package root: ${packageRootName}`, `جذر الحزمة: ${packageRootName}`, context.brand.languageMode),
    localizeTemplateText(`Preparation date: ${context.brand.preparationDate}`, `تاريخ الإعداد: ${context.brand.preparationDate}`, context.brand.languageMode),
    localizeTemplateText(`Implementing body: ${context.brand.implementingBody}`, `الجف‡ة المنفذة: ${context.brand.implementingBody}`, context.brand.languageMode),
    localizeTemplateText(`Consultant / researcher team: ${context.brand.consultantTeam}`, `الفريف‚ الاستشاري / البحثي: ${context.brand.consultantTeam}`, context.brand.languageMode),
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
    localizeTemplateText('- 01_Images: restored images, visualizations, and render-derived stills', '- 01_Images: صور ترميمية ولف‚طات تصور بصري وصور مشتف‚ة من الرندرة', context.brand.languageMode),
    localizeTemplateText('- 02_Plans: floor plans, urban plans, vector drawings, and printable sheets', '- 02_Plans: مخططات طوابف‚ ومخططات عمرانية ورسومات متجف‡ية ولوحات ف‚ابلة للطباعة', context.brand.languageMode),
    localizeTemplateText('- 03_3D_Models: print-ready and viewing-ready model exports', '- 03_3D_Models: مخرجات نماذج ثلاثية الأبعاد جاف‡زة للعرض والطباعة', context.brand.languageMode),
    localizeTemplateText('- 04_Reports: narrative reports, spreadsheets, metadata, and documentation tables', '- 04_Reports: تف‚ارير سردية وجداول بيانات وبيانات وصفية وجداول توثيف‚ية', context.brand.languageMode),
    localizeTemplateText('- 05_Presentations: presentation decks and board-style composition sheets', '- 05_Presentations: عروض تف‚ديمية ولوحات تركيبية بأسلوب معماري', context.brand.languageMode),
    localizeTemplateText('- 06_Dossier: comprehensive dossier and building-level documentation', '- 06_Dossier: الوثيف‚ة الشاملة وتوثيف‚ المباني', context.brand.languageMode),
    localizeTemplateText('- 07_Digital_Portfolio: standalone HTML delivery and portfolio assets', '- 07_Digital_Portfolio: موف‚ع HTML مستف‚ل وأصول المحفظة الرف‚مية', context.brand.languageMode),
    localizeTemplateText('- 08_Media: infographic and promotional media support files', '- 08_Media: ملفات الإنفوجرافيفƒ والمواد الإعلامية المساندة', context.brand.languageMode),
    '',
    localizeTemplateText('Usage guidance:', 'إرشادات الاستخدام:', context.brand.languageMode),
    localizeTemplateText('- Open PDF files for print-ready review.', '- افتح ملفات PDF للمراجعة والطباعة.', context.brand.languageMode),
    localizeTemplateText('- Edit DOCX files when narrative customization is needed.', '- حرر ملفات DOCX عند الحاجة إلف‰ تخصيص السرد أو التنسيف‚.', context.brand.languageMode),
    localizeTemplateText('- Open PPTX files and board sheets for decision-maker presentations.', '- افتح ملفات PPTX ولوحات العرض للعروض الموجف‡ة لأصحاب الف‚رار.', context.brand.languageMode),
    localizeTemplateText('- Open 07_Digital_Portfolio/HTML_Website/index.html in a browser for the portfolio view.', '- افتح 07_Digital_Portfolio/HTML_Website/index.html في المتصفح لعرض المحفظة الرف‚مية.', context.brand.languageMode),
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
    asset.copiedPath = destination;
    asset.relativePath = toWebPath(path.relative(packageRoot, destination));
    copiedAssets.push({
      ...asset,
      copiedPath: asset.copiedPath,
      relativePath: asset.relativePath,
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
    new Paragraph({ text: `${labelForLanguage('Consultant Team', 'الفريف‚ الاستشاري', context.brand.languageMode)}: ${context.brand.consultantTeam}`, alignment: paragraphAlign }),
    new Paragraph({ text: `${labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
    new Paragraph({ text: dossier.executiveSummary, alignment: paragraphAlign }),
    new Paragraph({ text: `${labelForLanguage('Methodology', 'المنف‡جية', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }),
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

  children.push(new Paragraph({ text: labelForLanguage('Building Documentation', 'توثيف‚ المباني', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  dossier.buildingRecords.forEach((building, index) => {
    children.push(new Paragraph({ text: `${index + 1}. ${building.name}`, heading: HeadingLevel.HEADING_2, alignment: paragraphAlign }));
    children.push(new Paragraph({ text: building.summary, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('References', 'المراجع', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
  dossier.references.forEach(ref => {
    children.push(new Paragraph({ text: `${ref.title} - ${ref.note}`, alignment: paragraphAlign }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Appendices', 'الملاحف‚', context.brand.languageMode), heading: HeadingLevel.HEADING_1, alignment: paragraphAlign }));
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
        setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(formatPdfText(labelForLanguage('Building Documentation', 'توثيف‚ المباني', context.brand.languageMode), context.brand.languageMode), { align });
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
      `أُعد ف‡ذا الملف الخاص بالمبنف‰ ضمن ${context.brand.projectName}. وف‚د جُمعت الأدلة المتاحة فيف‡ لأغراض العرض والمراجعة والتحرير اللاحف‚.`,
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
    setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(formatPdfText(labelForLanguage('Available Content', 'المحتوف‰ المتاح', context.brand.languageMode), context.brand.languageMode), { align });
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
  return repairDisplayText(value)
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
    { header: labelForLanguage('Field', 'الحف‚ل', languageMode), width: 28 },
    { header: labelForLanguage('Value', 'الف‚يمة', languageMode), width: 70 },
  ];
  [
    [labelForLanguage('Project Name', 'اسم المشروع', languageMode), context.brand.projectName],
    [labelForLanguage('Implementing Body', 'الجف‡ة المنفذة', languageMode), context.brand.implementingBody],
    [labelForLanguage('Preparation Date', 'تاريخ الإعداد', languageMode), context.brand.preparationDate],
    [labelForLanguage('Consultant Team', 'الفريف‚ الاستشاري', languageMode), context.brand.consultantTeam],
    [labelForLanguage('Language Mode', 'لغة الإخراج', languageMode), localizedLanguageMode(context.brand.languageMode, languageMode)],
    [labelForLanguage('Assets Indexed', 'الأصول المفف‡رسة', languageMode), contentModel.counts.totalAssets],
    [labelForLanguage('Images', 'الصور', languageMode), contentModel.counts.images],
    [labelForLanguage('Reports', 'التف‚ارير', languageMode), contentModel.counts.reports],
    [labelForLanguage('Models', 'النماذج', languageMode), contentModel.counts.models],
    [labelForLanguage('Presentations', 'العروض التف‚ديمية', languageMode), contentModel.counts.presentations],
  ].forEach(row => summary.addRow(row));

  const assets = workbook.addWorksheet(labelForLanguage('Asset Register', 'سجل الأصول', languageMode));
  assets.columns = [
    { header: labelForLanguage('Source', 'المصدر', languageMode), width: 28 },
    { header: labelForLanguage('Building', 'المبنف‰', languageMode), width: 28 },
    { header: labelForLanguage('District', 'النطاق', languageMode), width: 28 },
    { header: labelForLanguage('File', 'الملف', languageMode), width: 42 },
    { header: labelForLanguage('Type', 'النوع', languageMode), width: 18 },
    { header: labelForLanguage('Usage', 'الاستخدام', languageMode), width: 24 },
    { header: labelForLanguage('Size KB', 'الحجم فƒيلوبايت', languageMode), width: 12 },
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
    { header: labelForLanguage('Building', 'المبنف‰', languageMode), width: 34 },
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
  <text x="84" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Indexed project assets', 'أصول المشروع المفف‡رسة', languageMode))}</text>
  <text x="430" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#38bdf8">${dossier.buildingRecords.length}</text>
  <text x="430" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Building document groups', 'مجموعات وثائف‚ المباني', languageMode))}</text>
  <text x="760" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#10b981">${contentModel.counts.html + contentModel.counts.presentations + contentModel.counts.models}</text>
  <text x="760" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">${xmlEscape(labelForLanguage('Digital and presentation outputs', 'المخرجات الرف‚مية والعرضية', languageMode))}</text>
  ${sourceBlocks}
  <text x="84" y="740" font-size="18" font-family="Arial" fill="#f8fafc">${xmlEscape(labelForLanguage('Coverage', 'نطاف‚ التغطية', languageMode))}</text>
  <text x="84" y="772" font-size="15" font-family="Arial" fill="#cbd5e1">${xmlEscape(dossier.executiveSummary)}</text>
</svg>`;
}

async function buildInfographics(context, contentModel, dossier, mediaDir, options = {}) {
  const svgPath = path.join(mediaDir, 'project_infographic.svg');
  const pngPath = path.join(mediaDir, 'project_infographic.png');
  const pdfPath = path.join(mediaDir, 'project_infographic.pdf');
  const formats = new Set((Array.isArray(options.formats) && options.formats.length ? options.formats : ['svg', 'png', 'pdf'])
    .map(item => normalizeText(item).toLowerCase()));
  const needsSvgFile = formats.has('svg');
  const needsPngFile = formats.has('png');
  const needsPdfFile = formats.has('pdf');
  const svg = buildInfographicSvg(context, contentModel, dossier);
  if (needsSvgFile) fs.writeFileSync(svgPath, svg);

  let pngBuffer = null;
  if (needsPngFile || needsPdfFile) {
    pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  }
  if (needsPngFile && pngBuffer) {
    fs.writeFileSync(pngPath, pngBuffer);
  }
  if (needsPdfFile && pngBuffer) {
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 18 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);
      doc.image(pngBuffer, { fit: [560, 800], align: 'center', valign: 'center' });
      doc.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }

  return {
    svgPath: needsSvgFile ? svgPath : null,
    pngPath: needsPngFile ? pngPath : null,
    pdfPath: needsPdfFile ? pdfPath : null,
  };
}

function buildPromoScript(context, dossier, contentModel, narrativeBundle = null) {
  const aiDraft = normalizeMultiline(narrativeBundle?.promoScript, '');
  if (aiDraft) return aiDraft;
  return [
    localizeTemplateText(`Project: ${context.brand.projectName}`, `المشروع: ${context.brand.projectName}`, context.brand.languageMode),
    localizeTemplateText(`Style direction: ${context.project.brandingPreferences}`, `توجف‡ الف‡وية: ${context.project.brandingPreferences}`, context.brand.languageMode),
    '',
    localizeTemplateText('Suggested short promo structure:', 'هيكل مف‚ترح للمادة الترويجية الف‚صيرة:', context.brand.languageMode),
    localizeTemplateText('1. Opening title card with project identity and implementing body.', '1. افتتاحية بعنوان المشروع والجف‡ة المنفذة.', context.brand.languageMode),
    localizeTemplateText('2. Present the heritage context with restored visuals and key urban imagery.', '2. عرض السياف‚ التراثي من خلال الصور المعالجة واللف‚طات العمرانية الأساسية.', context.brand.languageMode),
    localizeTemplateText('3. Highlight architectural visualizations, building plans, and analytical reports.', '3. إبراز التصورات المعمارية والمخططات وتف‚ارير التحليل.', context.brand.languageMode),
    localizeTemplateText('4. Introduce 3D models, digital portfolio outputs, and implementation readiness.', '4. تف‚ديم النماذج ثلاثية الأبعاد ومخرجات المحفظة الرف‚مية وجاف‡زية التنفيذ.', context.brand.languageMode),
    localizeTemplateText('5. Close with the dossier, delivery package, and project impact statement.', '5. اختتام المادة بالوثيف‚ة الشاملة وحزمة التسليم وأثر المشروع.', context.brand.languageMode),
    '',
    localizeTemplateText(`Voiceover draft: ${dossier.executiveSummary}`, `مسودة التعليف‚ الصوتي: ${dossier.executiveSummary}`, context.brand.languageMode),
    '',
    localizeTemplateText('Key figures:', 'الأرف‚ام الرئيسية:', context.brand.languageMode),
    localizeTemplateText(`- Total indexed assets: ${contentModel.counts.totalAssets}`, `- إجمالي الأصول المفف‡رسة: ${contentModel.counts.totalAssets}`, context.brand.languageMode),
    localizeTemplateText(`- Building groups: ${dossier.buildingRecords.length}`, `- مجموعات المباني: ${dossier.buildingRecords.length}`, context.brand.languageMode),
    localizeTemplateText(`- Models: ${contentModel.counts.models}`, `- النماذج: ${contentModel.counts.models}`, context.brand.languageMode),
    localizeTemplateText(`- Reports: ${contentModel.counts.reports}`, `- التف‚ارير: ${contentModel.counts.reports}`, context.brand.languageMode),
  ].join('\n');
}

function buildSocialCaptions(context, contentModel, narrativeBundle = null) {
  const aiCaptions = Array.isArray(narrativeBundle?.socialCaptions)
    ? narrativeBundle.socialCaptions.map(item => normalizeText(item)).filter(Boolean)
    : [];
  if (aiCaptions.length) return aiCaptions.join('\n\n');
  return [
    localizeTemplateText(
      `Caption 1: ${context.brand.projectName} now includes a complete documentation and media package integrating restored imagery, heritage analysis, plans, reports, and 3D assets.`,
      `التعليف‚ 1: يتضمن ${context.brand.projectName} الآن حزمة توثيف‚ وإخراج إعلامي متفƒاملة تجمع الصور المعالجة والتحليل التراثي والمخططات والتف‚ارير والأصول ثلاثية الأبعاد.`,
      context.brand.languageMode,
    ),
    localizeTemplateText(
      `Caption 2: From restoration to presentation-ready delivery, the package organizes ${contentModel.counts.totalAssets} outputs into a professional handover format for review, publication, and digital sharing.`,
      `التعليف‚ 2: من الترميم إلف‰ التسليم الجاف‡ز للعرضي تنظم الحزمة عدد ${contentModel.counts.totalAssets} من المخرجات ضمن صيغة مف‡نية للمراجعة والنشر والمشارفƒة الرف‚مية.`,
      context.brand.languageMode,
    ),
    localizeTemplateText(
      'Caption 3: The project portfolio supports dossier preparation, building-level documentation, interactive browsing, and media-ready communication assets.',
      'التعليف‚ 3: تدعم محفظة المشروع إعداد الوثيف‚ة الشاملة وتوثيف‚ المباني والتصفح التفاعلي وأصول التواصل الجاف‡زة للإخراج الإعلامي.',
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
        <div class="panel"><strong>${copiedAssets.length}</strong><p>${xmlEscape(labelForLanguage('Packaged files copied into the structured delivery folder.', 'ملفات منسوخة إلف‰ مجلد التسليم المنظم.', context.brand.languageMode))}</p></div>
        <div class="panel"><strong>${dossier.buildingRecords.length}</strong><p>${xmlEscape(labelForLanguage('Building-level documentation groups.', 'مجموعات توثيف‚ علف‰ مستوف‰ المباني.', context.brand.languageMode))}</p></div>
        <div class="panel"><strong>${Object.keys(context.contentModel.bySource).length}</strong><p>${xmlEscape(labelForLanguage('Integrated source sets.', 'حزم مصادر مترابطة.', context.brand.languageMode))}</p></div>
      </div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Building Documentation', 'توثيف‚ المباني', context.brand.languageMode))}</h2>
      <div class="grid">${cards}</div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Visual Gallery', 'معرض بصري', context.brand.languageMode))}</h2>
      <div class="gallery">${gallery}</div>
    </section>

    <section>
      <h2>${xmlEscape(labelForLanguage('Interactive Embeds', 'محتوف‰ تفاعلي', context.brand.languageMode))}</h2>
      <div class="embeds">${iframeBlocks || `<div class="panel"><p>${xmlEscape(labelForLanguage('No interactive HTML outputs were linked. The package still includes standalone files and structured navigation.', 'لم يتم ربط مخرجات HTML تفاعليةي ومع ذلفƒ تتضمن الحزمة ملفات مستف‚لة وتنف‚لاف‹ منظماف‹.', context.brand.languageMode))}</p></div>`}</div>
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

function hasRenderableText(value = '') {
  return splitNarrativeParagraphs(value).length > 0;
}

function hasRenderableSection(section = {}) {
  return Boolean(normalizeText(section?.title)) && hasRenderableText(section?.body);
}

function hasRenderableBuildingRecord(building = {}) {
  return Boolean(normalizeText(building?.name)) && hasRenderableText(building?.summary);
}

function hasRenderableReference(ref = {}) {
  return Boolean(normalizeText(ref?.title) || normalizeText(ref?.note));
}

function assetRecordKey(asset = {}) {
  return normalizeText(
    asset?.id
    || asset?.copiedPath
    || asset?.path
    || `${normalizeText(asset?.name)}:${normalizeText(asset?.service)}:${normalizeText(asset?.type)}`,
  );
}

function uniqueAssets(assets = []) {
  const seen = new Set();
  return assets.filter(asset => {
    const key = assetRecordKey(asset);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatAssetReference(asset = {}, languageMode = 'english') {
  const name = normalizeText(asset?.name, labelForLanguage('Unnamed file', 'ملف بدون اسم', languageMode));
  const typeLabel = localizedAssetType(asset?.type, languageMode);
  const relativePath = normalizeText(asset?.relativePath);
  return relativePath
    ? `${name} (${typeLabel}) - ${relativePath}`
    : `${name} (${typeLabel})`;
}

function collectDossierAssetGroups(assetsInput = []) {
  const assets = uniqueAssets((assetsInput || []).filter(asset => asset && asset.copiedPath && asset.usage !== 'logo'));
  const webImages = assets.filter(asset => isWebReadyImage(fileExt(asset.copiedPath)));
  const splitServiceAssets = service => {
    const serviceAssets = assets.filter(asset => asset.service === service);
    return {
      assets: serviceAssets,
      imageAssets: serviceAssets.filter(asset => isWebReadyImage(fileExt(asset.copiedPath))),
      fileAssets: serviceAssets.filter(asset => !isWebReadyImage(fileExt(asset.copiedPath))),
    };
  };

  return {
    assets,
    heroImage: webImages[0] || null,
    service1: splitServiceAssets(1),
    service2: splitServiceAssets(2),
    service3: splitServiceAssets(3),
    service4: splitServiceAssets(4),
    service5: splitServiceAssets(5),
  };
}

function collectProjectWideAssetGroups(context = {}) {
  const assets = (context.contentModel?.assets || []).filter(asset => normalizeText(asset?.building, 'Project-wide') === 'Project-wide');
  return collectDossierAssetGroups(assets);
}

function buildCoverageSummaryLines(coverage = {}, languageMode = 'english') {
  return [
    localizeTemplateText(
      `Visual assets indexed: ${coverage.visualCount || 0}.`,
      `عدد الأصول البصرية المفهرسة: ${coverage.visualCount || 0}.`,
      languageMode,
    ),
    localizeTemplateText(
      `Architectural drawings indexed: ${coverage.drawingCount || 0}.`,
      `عدد الرسومات والمخططات المعمارية المفهرسة: ${coverage.drawingCount || 0}.`,
      languageMode,
    ),
    localizeTemplateText(
      `Reports and narrative documents indexed: ${coverage.reportCount || 0}.`,
      `عدد التقارير والوثائق السردية المفهرسة: ${coverage.reportCount || 0}.`,
      languageMode,
    ),
    localizeTemplateText(
      `Three-dimensional models indexed: ${coverage.modelCount || 0}, with ${coverage.interactiveCount || 0} interactive output(s).`,
      `عدد النماذج ثلاثية الأبعاد المفهرسة: ${coverage.modelCount || 0} مع ${coverage.interactiveCount || 0} مخرج تفاعلي.`,
      languageMode,
    ),
    localizeTemplateText(
      `Urban and geographic files indexed: ${coverage.mapCount || 0}.`,
      `عدد الملفات العمرانية والجغرافية المفهرسة: ${coverage.mapCount || 0}.`,
      languageMode,
    ),
  ].filter(hasRenderableText);
}

function getHistoricalNarrative(context = {}) {
  const languageMode = context.brand?.languageMode || 'english';
  const service4 = context.linkedJobs?.find(job => job.service === 4) || null;
  return service4?.metadata?.project?.description
    || service4?.metadata?.summary
    || labelForLanguage(
      'Historical analysis was prepared as part of the academic reporting phase. Refer to linked reports for the full narrative detail.',
      'أعد التحليل التاريخي ضمن مرحلة التقارير الأكاديمية. يرجى الرجوع إلى التقارير المرتبطة للاطلاع على السرد الكامل.',
      languageMode,
    );
}

function getOrderedServiceDossierChapters(assetGroups = {}, languageMode = 'english', options = {}) {
  const scope = options.scope === 'project' ? 'project' : 'building';
  const historicalNarrative = normalizeText(options.historicalNarrative);
  const chapterDefs = [
    {
      key: 'service1',
      titleEn: 'Before / After Photos',
      titleAr: 'صور قبل/بعد',
      introEn: scope === 'project'
        ? 'Project-level before/after, condition, and restoration imagery.'
        : 'Visual restoration and condition-reference images linked to this building.',
      introAr: scope === 'project'
        ? 'يتضمن هذا القسم صور قبل/بعد وصور الحالة الراهنة وصور الترميم المرتبطة على مستوى المشروع.'
        : 'صور مرجعية بصرية وصور ترميم مرتبطة بهذا المبنى.',
    },
    {
      key: 'service2',
      titleEn: 'Architectural Drawings',
      titleAr: 'المخططات والرسومات المعمارية',
      introEn: scope === 'project'
        ? 'Project-level plans, drawings, and architectural graphic packages.'
        : 'Plans, drawings, sections, and architectural graphic material linked to this building.',
      introAr: scope === 'project'
        ? 'يتضمن هذا القسم المخططات والرسومات والحزم المعمارية المرتبطة على مستوى المشروع.'
        : 'يتضمن هذا القسم المخططات والرسومات والقطاعات والمواد المعمارية المرتبطة بهذا المبنى.',
    },
    {
      key: 'service3',
      titleEn: '2D / 3D Visualizations',
      titleAr: 'التصورات الثنائية والثلاثية الأبعاد',
      introEn: scope === 'project'
        ? 'Project-level rendered studies, model packages, and visualization outputs.'
        : 'Rendered studies, models, and visualization outputs prepared for this building.',
      introAr: scope === 'project'
        ? 'يشمل هذا القسم الدراسات الإخراجية وحزم النماذج ومخرجات التصور المرتبطة على مستوى المشروع.'
        : 'يشمل هذا القسم الدراسات الإخراجية والنماذج ومخرجات التصور المعدة لهذا المبنى.',
    },
    {
      key: 'service4',
      titleEn: 'Historical Analysis',
      titleAr: 'التحليل التاريخي',
      introEn: scope === 'project'
        ? 'Historical analysis and academic narrative linked at project level.'
        : 'Historical analysis and academic narrative linked to this building.',
      introAr: scope === 'project'
        ? 'يتضمن هذا القسم التحليل التاريخي والسرد الأكاديمي المرتبطين على مستوى المشروع.'
        : 'يتضمن هذا القسم التحليل التاريخي والسرد الأكاديمي المرتبطين بهذا المبنى.',
      useHistoricalNarrative: true,
    },
    {
      key: 'service5',
      titleEn: 'Reports, Data, and Technical Files',
      titleAr: 'التقارير والبيانات والملفات الفنية',
      introEn: scope === 'project'
        ? 'Project-level reports, datasets, and technical documentation.'
        : 'Reports, datasets, and technical documentation linked to this building.',
      introAr: scope === 'project'
        ? 'يتضمن هذا القسم التقارير والبيانات والوثائق الفنية المرتبطة على مستوى المشروع.'
        : 'يتضمن هذا القسم التقارير والبيانات والوثائق الفنية الخاصة بهذا المبنى.',
    },
  ];

  return chapterDefs.map(def => {
    const bucket = assetGroups?.[def.key] || {};
    const imageAssets = bucket.imageAssets || [];
    const fileAssets = bucket.fileAssets || [];
    const assets = bucket.assets || [];
    if (!assets.length) return null;
    return {
      title: labelForLanguage(def.titleEn, def.titleAr, languageMode),
      intro: def.useHistoricalNarrative && historicalNarrative
        ? historicalNarrative
        : labelForLanguage(def.introEn, def.introAr, languageMode),
      imageAssets,
      fileAssets,
    };
  }).filter(Boolean);
}

function parseBooleanLike(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = normalizeText(value).toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
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
        // Best-effort extraction only.
      }
    }
    const asString = String(value);
    if (/^https?:\/\//i.test(asString)) urls.push(asString);
    Object.values(value).forEach(item => collectHttpUrls(item, urls));
  }
  return urls;
}

function cleanPresentationLabel(value, fallback = 'Visual') {
  const text = normalizeText(value, fallback)
    .replace(path.extname(value || ''), '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text
    .split(' ')
    .map(token => token ? `${token.charAt(0).toUpperCase()}${token.slice(1)}` : token)
    .join(' ');
}

function presentationAssetHaystack(asset = {}) {
  return [
    asset.name,
    asset.title,
    asset.building,
    asset.district,
    asset.relativePath,
    asset.path,
    asset.type,
    asset.usage,
  ].map(part => String(part || '').toLowerCase()).join(' ');
}

function classifyPresentationRoles(asset = {}) {
  const haystack = presentationAssetHaystack(asset);
  const roles = new Set();

  if (asset.service === 1) roles.add('restoration');
  if (asset.service === 3 || asset.type === 'map-data') roles.add('site');
  if (asset.service === 5) roles.add('three-dimensional');
  if (asset.type === 'drawing' || asset.usage === 'technical-drawing') roles.add('technical');
  if (asset.type === 'image') roles.add('visual');

  if (/before[_ -]?after|condition|restored|restoration/.test(haystack)) roles.add('restoration');
  if (/hero|overview|main|primary|cover/.test(haystack)) roles.add('hero');
  if (/floor ?plan|plan\b|roof plan|ground floor|layout/.test(haystack)) roles.add('plan');
  if (/site plan|master plan|masterplan|urban|district|map|geo|context/.test(haystack)) roles.add('site');
  if (/section|sectional|cut/.test(haystack)) roles.add('section');
  if (/elevation|facade|fa[çc]ade/.test(haystack)) roles.add('elevation');
  if (/function|functional|program|zoning/.test(haystack)) roles.add('functional');
  if (/circulation|access|movement|entry|route/.test(haystack)) roles.add('circulation');
  if (/landscape|plant|green|courtyard|open space/.test(haystack)) roles.add('landscape');
  if (/aerial|bird|birds eye|bird's eye|rooftop/.test(haystack)) roles.add('aerial');
  if (/night|evening|sunset|dusk/.test(haystack)) roles.add('night');
  if (/detail|close ?up|material|texture/.test(haystack)) roles.add('detail');
  if (/street|pedestrian|eye level|human scale/.test(haystack)) roles.add('eye-level');
  if (/diagram|analysis|scheme/.test(haystack)) roles.add('diagram');
  if (/render|perspective|view|visualization|visualisation/.test(haystack) || asset.service === 5) roles.add('perspective');

  if (!roles.has('hero') && (roles.has('perspective') || roles.has('visual'))) roles.add('hero-candidate');
  if (!roles.size && asset.type === 'image') roles.add('hero-candidate');

  return [...roles];
}

function isRenderablePresentationAsset(asset = {}) {
  const assetPath = asset.copiedPath || asset.path;
  const ext = fileExt(assetPath);
  if (!assetPath || !fs.existsSync(assetPath)) return false;
  return isImageExtension(ext) || ext === '.svg';
}

function buildPresentationAssetIndex(assets = []) {
  const renderable = uniqueAssets((assets || []).filter(isRenderablePresentationAsset))
    .map(asset => ({ ...asset, roles: classifyPresentationRoles(asset) }));
  const withRole = role => renderable.filter(asset => asset.roles.includes(role));

  return {
    all: renderable,
    hero: uniqueAssets([...withRole('hero'), ...withRole('hero-candidate'), ...withRole('perspective'), ...withRole('visual')]),
    restoration: uniqueAssets([...withRole('restoration')]),
    plans: uniqueAssets([...withRole('plan')]),
    elevations: uniqueAssets([...withRole('elevation')]),
    sections: uniqueAssets([...withRole('section')]),
    site: uniqueAssets([...withRole('site'), ...withRole('aerial')]),
    functional: uniqueAssets([...withRole('functional')]),
    circulation: uniqueAssets([...withRole('circulation')]),
    landscape: uniqueAssets([...withRole('landscape')]),
    aerial: uniqueAssets([...withRole('aerial')]),
    night: uniqueAssets([...withRole('night')]),
    detail: uniqueAssets([...withRole('detail')]),
    diagram: uniqueAssets([...withRole('diagram')]),
    perspectives: uniqueAssets([...withRole('perspective'), ...withRole('eye-level'), ...withRole('hero-candidate')]),
    technical: uniqueAssets([...withRole('technical'), ...withRole('plan'), ...withRole('elevation'), ...withRole('section')]),
  };
}

function pickPresentationAssets(primary = [], fallback = [], count = 1) {
  const selected = [];
  const seen = new Set();

  for (const list of [primary || [], fallback || []]) {
    for (const asset of list) {
      const key = assetRecordKey(asset);
      if (!key || seen.has(key)) continue;
      selected.push(asset);
      seen.add(key);
      if (selected.length >= count) return selected;
    }
  }

  return selected;
}

function cyclePresentationAsset(assets = [], index = 0) {
  if (!assets.length) return null;
  return assets[index % assets.length];
}

function wrapSvgText(text, maxChars = 42, maxLines = 2) {
  const normalized = compactText(text, maxChars * maxLines + 20);
  const words = normalized.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';

  words.forEach(word => {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars || !current) {
      current = candidate;
      return;
    }
    lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  const sliced = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    const last = sliced[maxLines - 1] || '';
    sliced[maxLines - 1] = compactText(last, Math.max(6, maxChars - 3));
  }
  return sliced.length ? sliced : [''];
}

function svgTextBlock(x, y, text, options = {}) {
  const lines = wrapSvgText(text, options.maxChars || 44, options.maxLines || 2);
  const fontSize = options.fontSize || 20;
  const lineHeight = options.lineHeight || Math.round(fontSize * 1.25);
  const fill = options.fill || '#0f172a';
  const fontWeight = options.fontWeight || 500;
  const anchor = options.anchor || 'start';
  const family = xmlEscape(options.fontFamily || 'Segoe UI, Arial, sans-serif');

  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${fontSize}" font-weight="${fontWeight}" text-anchor="${anchor}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${xmlEscape(line)}</tspan>`).join('')}</text>`;
}

function createSvgBuffer(width, height, body) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
    'utf8',
  );
}

function presentationTileCaption(asset = {}) {
  asset = asset || {};
  const assetLabel = cleanPresentationLabel(asset.name, 'Visual');
  const buildingLabel = normalizeText(asset.building);
  if (!buildingLabel || buildingLabel === 'Project-wide') return assetLabel;
  return compactText(`${assetLabel} - ${buildingLabel}`, 58);
}

async function renderPresentationTile(asset, width, height, outDir, options = {}) {
  const captionHeight = options.captionHeight ?? 68;
  const padding = options.padding ?? 18;
  const innerWidth = Math.max(1, width - (padding * 2));
  const innerHeight = Math.max(1, height - (padding * 2) - captionHeight);
  const assetPath = await resolveRenderableImagePath(asset.copiedPath || asset.path, outDir, {
    forcePng: true,
    suffix: `board_${slugify(asset.name, 'asset')}`,
  });
  const fit = options.fit || (asset.roles?.some(role => ['plan', 'site', 'section', 'elevation', 'technical', 'diagram'].includes(role)) ? 'contain' : 'cover');
  const imageBuffer = await sharp(assetPath)
    .resize({
      width: innerWidth,
      height: innerHeight,
      fit,
      position: fit === 'cover' ? 'attention' : 'center',
      background: '#ffffff',
    })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();

  const panelSvg = createSvgBuffer(width, height, `
    <rect x="0" y="0" width="${width}" height="${height}" rx="26" fill="#ffffff"/>
    <rect x="0.75" y="0.75" width="${width - 1.5}" height="${height - 1.5}" rx="26" fill="none" stroke="#d6d3d1" stroke-width="1.5"/>
    <rect x="${padding}" y="${height - captionHeight - padding}" width="${innerWidth}" height="${captionHeight}" rx="18" fill="#fafaf9"/>
    <rect x="0" y="0" width="${width}" height="${height}" rx="26" fill="none" stroke="#e7e5e4" stroke-width="2"/>
  `);

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#ffffff',
    },
  })
    .composite([
      { input: panelSvg, left: 0, top: 0 },
      { input: imageBuffer, left: padding, top: padding },
    ])
    .png()
    .toBuffer();
}

function buildPresentationBoardTypography(spec = {}, context = {}, width = 1920, height = 1080) {
  const fontFamily = fontFamilyStack(context.brand?.typography, context.brand?.languageMode);
  const accent = spec.accentColor || context.brand?.primaryColor || '#1a3554';
  const eyebrow = normalizeText(spec.eyebrow);
  const title = normalizeText(spec.title);
  const subtitle = normalizeText(spec.subtitle);
  const footer = normalizeText(spec.footer);
  const captionBlocks = (spec.placements || []).map(item => {
    const caption = normalizeText(item.caption || presentationTileCaption(item.asset));
    if (!caption) return '';
    return svgTextBlock(item.x + 20, item.y + item.h - 30, caption, {
      fontSize: 18,
      maxChars: Math.max(18, Math.floor((item.w - 40) / 12)),
      maxLines: 2,
      fill: '#334155',
      fontWeight: 500,
      fontFamily,
    });
  }).join('');

  return createSvgBuffer(width, height, `
    <defs>
      <linearGradient id="boardAccent" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="${accent}"/>
        <stop offset="100%" stop-color="#d6a95d"/>
      </linearGradient>
    </defs>
    <rect x="72" y="72" width="${width - 144}" height="${height - 144}" rx="34" fill="none" stroke="#e7e5e4" stroke-width="1.5"/>
    <rect x="72" y="72" width="240" height="8" rx="4" fill="url(#boardAccent)"/>
    ${eyebrow ? svgTextBlock(84, 118, eyebrow, { fontSize: 22, fontWeight: 600, fill: accent, maxChars: 28, maxLines: 1, fontFamily }) : ''}
    ${title ? svgTextBlock(84, 170, title, { fontSize: 42, fontWeight: 700, fill: '#0f172a', maxChars: 40, maxLines: 2, fontFamily }) : ''}
    ${subtitle ? svgTextBlock(84, 236, subtitle, { fontSize: 22, fontWeight: 400, fill: '#475569', maxChars: 72, maxLines: 2, fontFamily }) : ''}
    ${footer ? svgTextBlock(width - 84, height - 42, footer, { fontSize: 16, fontWeight: 500, fill: '#64748b', anchor: 'end', maxChars: 80, maxLines: 1, fontFamily }) : ''}
    ${captionBlocks}
  `);
}

async function refinePresentationBoardWithNanoBanana(basePath, referenceAssets, outPath, spec = {}) {
  if (!replicate) return null;
  if (!fs.existsSync(basePath)) return null;

  const tempDir = path.join(path.dirname(outPath), '_nano_banana_tmp');
  ensureDir(tempDir);

  const prepareNanoBananaInputImage = async (filePath, label, maxWidth = 1400, maxHeight = 1400) => {
    const renderPath = await resolveRenderableImagePath(filePath, tempDir, {
      forcePng: true,
      suffix: `nb_${slugify(label, 'img')}`,
    });
    if (!renderPath || !fs.existsSync(renderPath)) return null;
    const preparedPath = path.join(tempDir, `${slugify(label, 'img')}_prepared.jpg`);
    await sharp(renderPath)
      .flatten({ background: '#ffffff' })
      .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true, background: '#ffffff' })
      .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
      .toFile(preparedPath);
    return preparedPath;
  };

  const sanitizedBase = await prepareNanoBananaInputImage(basePath, `${normalizeText(spec.title, 'board')}_base`, 1536, 1536);
  if (!sanitizedBase) return null;

  const sanitizedRefs = [];
  for (const asset of uniqueAssets((referenceAssets || []).filter(Boolean))) {
    const sourcePath = asset.copiedPath || asset.path;
    if (!sourcePath || !fs.existsSync(sourcePath)) continue;
    const prepared = await prepareNanoBananaInputImage(sourcePath, asset.name || path.basename(sourcePath), 1200, 1200);
    if (prepared && !sanitizedRefs.includes(prepared)) sanitizedRefs.push(prepared);
    if (sanitizedRefs.length >= 3) break;
  }

  const defaultBoardPrompt = [
    'Refine this architecture presentation board into a premium competition-style review sheet.',
    `Primary subject: ${normalizeText(spec.title, 'Architectural presentation board')}.`,
    'Preserve the exact building identity, massing, materials, and viewpoints from the references.',
    'Do not redesign the project, invent unrelated buildings, or disturb the board layout.',
    'Keep a clean neutral sheet background, elegant image panels, and coherent visual harmony.',
  ].join(' ');
  const prompt = compactText(spec.boardPromptOverride || defaultBoardPrompt, 900);

  const attempts = [
    [sanitizedBase, ...sanitizedRefs.slice(0, 2)],
    [sanitizedBase, ...sanitizedRefs.slice(0, 1)],
    [sanitizedBase],
  ].filter(paths => paths.length);

  let lastError = null;
  for (const paths of attempts) {
    try {
      const input = {
        prompt,
        image_input: paths.map(fileToDataUri),
        output_format: 'png',
        aspect_ratio: '16:9',
        resolution: '1K',
        number_of_images: 1,
      };

      const output = await replicate.run(SERVICE_06_BOARD_IMAGE_MODEL, { input });
      const outputUrls = [...new Set(collectHttpUrls(output))];
      const imageUrl = outputUrls.find(url => /\.(png|jpe?g|webp)(\?|$)/i.test(url)) || outputUrls[0];
      if (!imageUrl) throw new Error('Replicate Nano Banana output was empty.');

      const tempPath = `${outPath}.download`;
      await downloadFile(imageUrl, tempPath);
      await sharp(tempPath)
        .resize(1920, 1080, { fit: 'cover', position: 'attention' })
        .png()
        .toFile(outPath);
      fs.unlinkSync(tempPath);
      return outPath;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const recoverable = /invalid input|E006|ReadTimeout|timeout/i.test(message);
      if (!recoverable) break;
    }
  }

  if (lastError) throw lastError;
  return null;
}

async function buildPresentationBoardImage(spec, outPath, context, options = {}) {
  const width = 1920;
  const height = 1080;
  ensureDir(path.dirname(outPath));
  const tempDir = path.join(path.dirname(outPath), '_board_tmp');
  ensureDir(tempDir);

  const baseComposites = [];
  for (const placement of spec.placements || []) {
    if (!placement.asset) continue;
    const tileBuffer = await renderPresentationTile(placement.asset, placement.w, placement.h, tempDir, {
      fit: placement.fit,
      captionHeight: placement.captionHeight,
    });
    baseComposites.push({ input: tileBuffer, left: placement.x, top: placement.y });
  }

  const backgroundSvg = createSvgBuffer(width, height, `
    <defs>
      <linearGradient id="bgWash" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#fcfbf8"/>
        <stop offset="100%" stop-color="#f3f1ec"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#bgWash)"/>
    <circle cx="1670" cy="190" r="280" fill="#f5efe5"/>
    <circle cx="240" cy="970" r="240" fill="#f1ede5"/>
  `);

  const baseBuffer = await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#fafaf9',
    },
  })
    .composite([
      { input: backgroundSvg, left: 0, top: 0 },
      ...baseComposites,
    ])
    .png()
    .toBuffer();

  const basePath = path.join(tempDir, `${slugify(spec.title, 'board')}_base.png`);
  fs.writeFileSync(basePath, baseBuffer);

  let refinedSourcePath = basePath;
  if (parseBooleanLike(options.enableNanoBanana, true) && spec.enableRefine !== false) {
    try {
      const refinedPath = path.join(tempDir, `${slugify(spec.title, 'board')}_refined.png`);
      const specWithOverride = options.boardPromptOverride
        ? { ...spec, boardPromptOverride: options.boardPromptOverride }
        : spec;
      const result = await refinePresentationBoardWithNanoBanana(basePath, (spec.placements || []).map(item => item.asset), refinedPath, specWithOverride);
      if (result && fs.existsSync(result)) refinedSourcePath = result;
    } catch (error) {
      refinedSourcePath = basePath;
    }
  }

  const finalTypography = buildPresentationBoardTypography(spec, context, width, height);
  await sharp(refinedSourcePath)
    .composite([{ input: finalTypography, left: 0, top: 0 }])
    .png()
    .toFile(outPath);
  return outPath;
}

async function buildCoverPresentationBoard(subject, index, context, outPath) {
  const width = 1920;
  const height = 1080;
  ensureDir(path.dirname(outPath));
  const tempDir = path.join(path.dirname(outPath), '_board_tmp');
  ensureDir(tempDir);
  const heroAsset = cyclePresentationAsset(index.hero.length ? index.hero : index.all, 0);
  const heroPath = heroAsset
    ? await resolveRenderableImagePath(heroAsset.copiedPath || heroAsset.path, tempDir, {
      forcePng: true,
      suffix: `cover_${slugify(subject.name, 'subject')}`,
    })
    : null;
  const heroBuffer = heroPath && fs.existsSync(heroPath)
    ? await sharp(heroPath)
      .resize({ width, height, fit: 'cover', position: 'attention' })
      .png()
      .toBuffer()
    : await sharp({
      create: { width, height, channels: 4, background: '#e7e5e4' },
    }).png().toBuffer();
  const fontFamily = fontFamilyStack(context.brand?.typography, context.brand?.languageMode);
  const accent = context.brand?.primaryColor || '#1a3554';
  const overlay = createSvgBuffer(width, height, `
    <defs>
      <linearGradient id="coverShade" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="rgba(15,23,42,0.82)"/>
        <stop offset="50%" stop-color="rgba(15,23,42,0.52)"/>
        <stop offset="100%" stop-color="rgba(15,23,42,0.18)"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#coverShade)"/>
    <rect x="82" y="92" width="280" height="8" rx="4" fill="${accent}"/>
    ${svgTextBlock(92, 154, labelForLanguage('Architectural Presentation Package', 'حزمة عرض معمارية', context.brand.languageMode), {
      fontSize: 24,
      maxChars: 34,
      maxLines: 2,
      fill: '#f8fafc',
      fontWeight: 600,
      fontFamily,
    })}
    ${svgTextBlock(92, 260, subject.name, {
      fontSize: 56,
      maxChars: 24,
      maxLines: 2,
      fill: '#ffffff',
      fontWeight: 700,
      fontFamily,
    })}
    ${svgTextBlock(92, 390, subject.summary, {
      fontSize: 24,
      maxChars: 58,
      maxLines: 3,
      fill: '#e2e8f0',
      fontWeight: 400,
      fontFamily,
    })}
    ${svgTextBlock(92, 980, `${context.brand.projectName}   |   ${context.brand.preparationDate}`, {
      fontSize: 18,
      maxChars: 72,
      maxLines: 1,
      fill: '#e2e8f0',
      fontWeight: 500,
      fontFamily,
    })}
  `);
  await sharp(heroBuffer).composite([{ input: overlay, left: 0, top: 0 }]).png().toFile(outPath);
  return outPath;
}

async function buildSummaryPresentationBoard(subject, index, context, outPath, summaryOptions = {}) {
  const width = 1920;
  const height = 1080;
  ensureDir(path.dirname(outPath));
  const tempDir = path.join(path.dirname(outPath), '_board_tmp');
  ensureDir(tempDir);
  const primaryAsset = cyclePresentationAsset(index.hero.length ? index.hero : index.all, 0);
  const secondaryAsset = cyclePresentationAsset(index.site.length ? index.site : index.perspectives.length ? index.perspectives : index.all, 1);
  const composites = [];

  if (primaryAsset) {
    const tile = await renderPresentationTile(primaryAsset, 930, 530, tempDir, { fit: 'cover' });
    composites.push({ input: tile, left: 900, top: 160 });
  }
  if (secondaryAsset) {
    const tile = await renderPresentationTile(secondaryAsset, 930, 250, tempDir, { fit: 'contain' });
    composites.push({ input: tile, left: 900, top: 730 });
  }

  const metrics = summaryOptions.metrics || [];
  const notes = (summaryOptions.notes || []).slice(0, 4);
  const fontFamily = fontFamilyStack(context.brand?.typography, context.brand?.languageMode);
  const accent = context.brand?.primaryColor || '#1a3554';
  const metricsSvg = metrics.map((metric, indexMetric) => {
    const y = 394 + (indexMetric * 136);
    return `
      <rect x="84" y="${y}" width="706" height="104" rx="26" fill="#ffffff" stroke="#e7e5e4"/>
      ${svgTextBlock(124, y + 46, String(metric.value), {
        fontSize: 34,
        maxChars: 14,
        maxLines: 1,
        fill: accent,
        fontWeight: 700,
        fontFamily,
      })}
      ${svgTextBlock(124, y + 80, String(metric.label), {
        fontSize: 18,
        maxChars: 42,
        maxLines: 2,
        fill: '#475569',
        fontWeight: 500,
        fontFamily,
      })}
    `;
  }).join('');

  const notesSvg = notes.map((note, indexNote) => {
    const y = 196 + (indexNote * 62);
    return `
      <circle cx="102" cy="${y - 8}" r="6" fill="${accent}"/>
      ${svgTextBlock(124, y, note, {
        fontSize: 22,
        maxChars: 44,
        maxLines: 2,
        fill: '#334155',
        fontWeight: 400,
        fontFamily,
      })}
    `;
  }).join('');

  const overlay = createSvgBuffer(width, height, `
    <defs>
      <linearGradient id="sumBg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0%" stop-color="#fcfbf8"/>
        <stop offset="100%" stop-color="#f3f1ec"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" fill="url(#sumBg)"/>
    <rect x="84" y="90" width="240" height="8" rx="4" fill="${accent}"/>
    ${svgTextBlock(84, 148, summaryOptions.eyebrow || labelForLanguage('Project Snapshot', 'لقطة المشروع', context.brand.languageMode), {
      fontSize: 22,
      maxChars: 28,
      maxLines: 1,
      fill: accent,
      fontWeight: 600,
      fontFamily,
    })}
    ${svgTextBlock(84, 222, summaryOptions.title || subject.name, {
      fontSize: 44,
      maxChars: 28,
      maxLines: 2,
      fill: '#0f172a',
      fontWeight: 700,
      fontFamily,
    })}
    ${svgTextBlock(84, 318, summaryOptions.subtitle || subject.summary, {
      fontSize: 22,
      maxChars: 46,
      maxLines: 3,
      fill: '#475569',
      fontWeight: 400,
      fontFamily,
    })}
    ${notesSvg}
    ${metricsSvg}
    ${svgTextBlock(width - 84, height - 42, summaryOptions.footer || context.brand.projectName, {
      fontSize: 16,
      maxChars: 72,
      maxLines: 1,
      fill: '#64748b',
      fontWeight: 500,
      anchor: 'end',
      fontFamily,
    })}
  `);

  await sharp({
    create: { width, height, channels: 4, background: '#fafaf9' },
  }).composite([
    { input: overlay, left: 0, top: 0 },
    ...composites,
  ]).png().toFile(outPath);
  return outPath;
}

function buildBoardLayout(layoutName, assets = []) {
  const pool = assets.length ? assets : [null];
  const assetAt = index => cyclePresentationAsset(pool, index);
  const standardCaption = asset => (asset ? presentationTileCaption(asset) : '');

  if (layoutName === 'technical-sheet') {
    return [
      { x: 84, y: 250, w: 836, h: 396, fit: 'contain', asset: assetAt(0), caption: standardCaption(assetAt(0)) },
      { x: 964, y: 250, w: 872, h: 396, fit: 'contain', asset: assetAt(1), caption: standardCaption(assetAt(1)) },
      { x: 84, y: 688, w: 568, h: 284, fit: 'contain', asset: assetAt(2), caption: standardCaption(assetAt(2)) },
      { x: 676, y: 688, w: 568, h: 284, fit: 'contain', asset: assetAt(3), caption: standardCaption(assetAt(3)) },
      { x: 1268, y: 688, w: 568, h: 284, fit: 'cover', asset: assetAt(4), caption: standardCaption(assetAt(4)) },
    ].filter(item => item.asset);
  }

  if (layoutName === 'analysis-sheet') {
    return [
      { x: 84, y: 226, w: 568, h: 246, fit: 'contain', asset: assetAt(0), caption: standardCaption(assetAt(0)) },
      { x: 676, y: 226, w: 568, h: 246, fit: 'contain', asset: assetAt(1), caption: standardCaption(assetAt(1)) },
      { x: 1268, y: 226, w: 568, h: 246, fit: 'contain', asset: assetAt(2), caption: standardCaption(assetAt(2)) },
      { x: 84, y: 514, w: 1150, h: 458, fit: 'contain', asset: assetAt(3), caption: standardCaption(assetAt(3)) },
      { x: 1268, y: 514, w: 568, h: 458, fit: 'cover', asset: assetAt(4), caption: standardCaption(assetAt(4)) },
    ].filter(item => item.asset);
  }

  if (layoutName === 'diptych') {
    return [
      { x: 84, y: 248, w: 872, h: 724, fit: 'cover', asset: assetAt(0), caption: standardCaption(assetAt(0)) },
      { x: 964, y: 248, w: 872, h: 724, fit: 'cover', asset: assetAt(1), caption: standardCaption(assetAt(1)) },
    ].filter(item => item.asset);
  }

  if (layoutName === 'gallery-sheet') {
    return [
      { x: 84, y: 242, w: 1752, h: 386, fit: 'cover', asset: assetAt(0), caption: standardCaption(assetAt(0)) },
      { x: 84, y: 662, w: 426, h: 310, fit: 'cover', asset: assetAt(1), caption: standardCaption(assetAt(1)) },
      { x: 534, y: 662, w: 426, h: 310, fit: 'cover', asset: assetAt(2), caption: standardCaption(assetAt(2)) },
      { x: 984, y: 662, w: 426, h: 310, fit: 'cover', asset: assetAt(3), caption: standardCaption(assetAt(3)) },
      { x: 1434, y: 662, w: 402, h: 310, fit: 'cover', asset: assetAt(4), caption: standardCaption(assetAt(4)) },
    ].filter(item => item.asset);
  }

  return [
    { x: 84, y: 242, w: 1118, h: 730, fit: 'cover', asset: assetAt(0), caption: standardCaption(assetAt(0)) },
    { x: 1230, y: 242, w: 606, h: 228, fit: 'cover', asset: assetAt(1), caption: standardCaption(assetAt(1)) },
    { x: 1230, y: 498, w: 606, h: 228, fit: 'cover', asset: assetAt(2), caption: standardCaption(assetAt(2)) },
    { x: 1230, y: 754, w: 606, h: 218, fit: 'contain', asset: assetAt(3), caption: standardCaption(assetAt(3)) },
  ].filter(item => item.asset);
}

function buildArchitecturalDeckPlan(subject, index, context, options = {}) {
  const languageMode = context.brand.languageMode;
  const coverage = options.coverage || {};
  const buildingCount = options.buildingCount || 1;
  const all = index.all;
  const mix = (...groups) => uniqueAssets(groups.flat().filter(Boolean));

  const overviewPool = mix(index.hero, index.perspectives, index.site, all);
  const restorationPool = mix(index.restoration, index.hero, index.perspectives, all);
  const sitePool = mix(index.site, index.aerial, index.perspectives, all);
  const plansPool = mix(index.plans, index.site, index.technical, all);
  const sectionsPool = mix(index.elevations, index.sections, index.detail, index.plans, all);
  const analysisPool = mix(index.functional, index.circulation, index.landscape, index.diagram, index.site, all);
  const viewsPool = mix(index.perspectives, index.hero, index.detail, all);
  const nightPool = mix(index.night, index.hero, index.perspectives, all);
  const detailPool = mix(index.detail, index.elevations, index.sections, index.perspectives, all);
  const reviewPool = mix(index.technical, index.perspectives, index.site, all);

  return [
    { kind: 'cover', fileSlug: '01_cover' },
    {
      kind: 'summary',
      fileSlug: '02_snapshot',
      title: subject.name,
      subtitle: subject.summary,
      metrics: [
        { label: labelForLanguage('Visual Assets', 'الأصول البصرية', languageMode), value: coverage.visualCount || index.all.length || 0 },
        { label: labelForLanguage('Technical Drawings', 'الرسومات الفنية', languageMode), value: coverage.drawingCount || index.technical.length || 0 },
        { label: labelForLanguage('3D / Render Views', 'المشاهد ثلاثية الأبعاد', languageMode), value: index.perspectives.length || 0 },
        { label: labelForLanguage('Buildings Covered', 'المباني المغطاة', languageMode), value: buildingCount },
      ],
      notes: [
        labelForLanguage('Image-led presentation package curated from Services 01 to 05.', 'حزمة عرض بصرية منسقة من الخدمات 01 إلى 05.', languageMode),
        labelForLanguage('Layouts are optimized for decision-maker review rather than text-heavy reporting.', 'تم تحسين اللوحات لعرض صناع القرار بدلاً من التقارير النصية الثقيلة.', languageMode),
        labelForLanguage('Boards combine hero imagery, drawings, plans, and analytical support where available.', 'تجمع اللوحات بين الصورة الرئيسية والرسومات والمخططات والتحليلات عند توفرها.', languageMode),
      ],
    },
    { kind: 'board', fileSlug: '03_overview', layout: 'hero-grid', title: labelForLanguage('Building Overview', 'نظرة عامة على المبنى', languageMode), subtitle: labelForLanguage('Hero perspective with supporting views and key presentation visuals.', 'منظور رئيسي مع مشاهد داعمة وعناصر عرض أساسية.', languageMode), eyebrow: labelForLanguage('Overview', 'نظرة عامة', languageMode), assets: pickPresentationAssets(overviewPool, all, 4) },
    { kind: 'board', fileSlug: '04_restoration', layout: 'diptych', title: labelForLanguage('Restoration Identity', 'هوية الترميم', languageMode), subtitle: labelForLanguage('Condition, rehabilitation, and image-based identity preservation.', 'الحالة والتأهيل والحفاظ على هوية المشروع بصرياً.', languageMode), eyebrow: labelForLanguage('Preservation', 'الحفاظ', languageMode), assets: pickPresentationAssets(restorationPool, all, 2) },
    { kind: 'board', fileSlug: '05_site_context', layout: 'technical-sheet', title: labelForLanguage('Site and Urban Context', 'الموقع والسياق العمراني', languageMode), subtitle: labelForLanguage('Master/site information, aerial context, and geographic framing.', 'معلومات المخطط العام والموقع والسياق الجوي والإطار الجغرافي.', languageMode), eyebrow: labelForLanguage('Context', 'السياق', languageMode), assets: pickPresentationAssets(sitePool, all, 5), enableRefine: false },
    { kind: 'board', fileSlug: '06_plans', layout: 'technical-sheet', title: labelForLanguage('Plans and Spatial Structure', 'المخططات والبنية المكانية', languageMode), subtitle: labelForLanguage('Plans, site diagrams, and spatial organization sheets.', 'لوحات المخططات والموقع والتنظيم المكاني.', languageMode), eyebrow: labelForLanguage('Plans', 'المخططات', languageMode), assets: pickPresentationAssets(plansPool, all, 5), enableRefine: false },
    { kind: 'board', fileSlug: '07_sections_elevations', layout: 'technical-sheet', title: labelForLanguage('Elevations and Sections', 'الواجهات والقطاعات', languageMode), subtitle: labelForLanguage('Technical reading of facade, section, and architectural envelope.', 'قراءة فنية للواجهة والقطاع والغلاف المعماري.', languageMode), eyebrow: labelForLanguage('Technical Sheet', 'لوحة فنية', languageMode), assets: pickPresentationAssets(sectionsPool, all, 5), enableRefine: false },
    { kind: 'board', fileSlug: '08_analysis', layout: 'analysis-sheet', title: labelForLanguage('Functional, Circulation, and Landscape Analysis', 'تحليل الوظائف والحركة واللاندسكيب', languageMode), subtitle: labelForLanguage('Diagram-led board for movement, use, and open-space logic.', 'لوحة تحليلية للحركة والاستخدام ومنطق المساحات المفتوحة.', languageMode), eyebrow: labelForLanguage('Analysis', 'التحليل', languageMode), assets: pickPresentationAssets(analysisPool, all, 5), enableRefine: false },
    { kind: 'board', fileSlug: '09_perspectives', layout: 'gallery-sheet', title: labelForLanguage('Exterior Perspectives', 'المناظير الخارجية', languageMode), subtitle: labelForLanguage('Primary hero render supported by alternative presentation views.', 'منظور رئيسي مدعوم بمشاهد عرض بديلة.', languageMode), eyebrow: labelForLanguage('Perspectives', 'المناظير', languageMode), assets: pickPresentationAssets(viewsPool, all, 5) },
    { kind: 'board', fileSlug: '10_aerial', layout: 'gallery-sheet', title: labelForLanguage('Aerial and Master Planning Views', 'المشاهد الجوية والمخطط العام', languageMode), subtitle: labelForLanguage('Bird’s-eye and context-rich views for board-level storytelling.', 'مشاهد جوية وغنية بالسياق لسرد بصري على مستوى اللوحات.', languageMode), eyebrow: labelForLanguage('Aerial', 'جوي', languageMode), assets: pickPresentationAssets(sitePool, all, 5) },
    { kind: 'board', fileSlug: '11_day_night', layout: 'diptych', title: labelForLanguage('Day and Night Character', 'الطابع النهاري والليلي', languageMode), subtitle: labelForLanguage('Lighting mood, facade character, and atmosphere across views.', 'أجواء الإضاءة وشخصية الواجهة والجو العام عبر المشاهد.', languageMode), eyebrow: labelForLanguage('Mood Study', 'دراسة المزاج البصري', languageMode), assets: pickPresentationAssets(nightPool, all, 2) },
    { kind: 'board', fileSlug: '12_detail', layout: 'gallery-sheet', title: labelForLanguage('Architectural Detail and Material Reading', 'قراءة التفاصيل والمواد', languageMode), subtitle: labelForLanguage('Close-up detail, envelope logic, and refined supporting visuals.', 'تفاصيل مقربة ومنطق الغلاف المعماري وصور داعمة مصقولة.', languageMode), eyebrow: labelForLanguage('Detail', 'التفاصيل', languageMode), assets: pickPresentationAssets(detailPool, all, 5) },
    { kind: 'board', fileSlug: '13_review_panel', layout: 'analysis-sheet', title: labelForLanguage('Design Review Panel', 'لوحة مراجعة التصميم', languageMode), subtitle: labelForLanguage('Balanced sheet mixing views, drawings, and strategic evidence.', 'لوحة متوازنة تجمع بين المشاهد والرسومات والأدلة الاستراتيجية.', languageMode), eyebrow: labelForLanguage('Review', 'المراجعة', languageMode), assets: pickPresentationAssets(reviewPool, all, 5), enableRefine: false },
    {
      kind: 'summary',
      fileSlug: '14_documentation',
      title: labelForLanguage('Documentation Summary', 'ملخص التوثيق', languageMode),
      subtitle: labelForLanguage('Package readiness for client review, academic presentation, and design communication.', 'جاهزية الحزمة للمراجعة العميلية والعرض الأكاديمي والتواصل التصميمي.', languageMode),
      eyebrow: labelForLanguage('Readiness', 'الجاهزية', languageMode),
      metrics: [
        { label: labelForLanguage('Indexed Files', 'الملفات المفهرسة', languageMode), value: options.totalAssets || index.all.length || 0 },
        { label: labelForLanguage('Presentation Boards', 'لوحات العرض', languageMode), value: 15 },
        { label: labelForLanguage('Decision-Ready Slides', 'شرائح جاهزة للقرار', languageMode), value: 15 },
      ],
      notes: [
        labelForLanguage('Visual hierarchy is prioritized over long-form narrative.', 'تم إعطاء الأولوية للهرمية البصرية بدلاً من السرد الطويل.', languageMode),
        labelForLanguage('All boards preserve the original project identity while improving presentation polish.', 'تحافظ جميع اللوحات على هوية المشروع الأصلية مع تحسين جودة العرض.', languageMode),
        labelForLanguage('Nano Banana 2 refinement is applied when the external provider is available.', 'يتم تطبيق تحسين Nano Banana 2 عند توفر المزود الخارجي.', languageMode),
      ],
    },
    {
      kind: 'summary',
      fileSlug: '15_closing',
      title: labelForLanguage('Presentation Conclusion', 'خاتمة العرض', languageMode),
      subtitle: labelForLanguage('A polished visual package prepared for review panels, clients, and academic juries.', 'حزمة بصرية مصقولة ومجهزة للجان المراجعة والعملاء والتحكيم الأكاديمي.', languageMode),
      eyebrow: labelForLanguage('Closing', 'الختام', languageMode),
      metrics: [
        { label: labelForLanguage('Hero Views', 'المشاهد الرئيسية', languageMode), value: Math.max(1, index.hero.length) },
        { label: labelForLanguage('Technical Sheets', 'اللوحات الفنية', languageMode), value: Math.max(1, index.technical.length) },
        { label: labelForLanguage('Analysis Boards', 'لوحات التحليل', languageMode), value: Math.max(1, index.diagram.length + index.site.length) },
      ],
      notes: [
        labelForLanguage('Designed to look like a real architectural competition or design-review package.', 'تم تصميمها لتبدو كحزمة عرض معمارية حقيقية لمسابقات أو مراجعات التصميم.', languageMode),
        labelForLanguage('Suitable for PowerPoint delivery and optional board export workflows.', 'مناسبة للتسليم عبر PowerPoint ولتدفقات تصدير اللوحات عند الحاجة.', languageMode),
      ],
    },
  ];
}

async function buildPresentationBoardsFromPlan(plan, subject, index, context, boardsDir, options = {}) {
  const slides = [];
  ensureDir(boardsDir);

  for (const item of plan) {
    const outPath = path.join(boardsDir, `${item.fileSlug}.png`);

    if (item.kind === 'cover') {
      await buildCoverPresentationBoard(subject, index, context, outPath);
      slides.push({ imagePath: outPath, title: subject.name });
      continue;
    }

    if (item.kind === 'summary') {
      await buildSummaryPresentationBoard(subject, index, context, outPath, {
        title: item.title,
        subtitle: item.subtitle,
        eyebrow: item.eyebrow,
        metrics: item.metrics,
        notes: item.notes,
        footer: context.brand.projectName,
      });
      slides.push({ imagePath: outPath, title: item.title });
      continue;
    }

    const placements = buildBoardLayout(item.layout, item.assets || []);
    await buildPresentationBoardImage({
      title: item.title,
      subtitle: item.subtitle,
      eyebrow: item.eyebrow,
      footer: context.brand.projectName,
      accentColor: context.brand.primaryColor,
      placements,
      enableRefine: item.enableRefine !== false,
    }, outPath, context, options);
    slides.push({ imagePath: outPath, title: item.title });
  }

  return slides;
}

async function buildImageBoardPptx(slides, reportTitle, outPath) {
  const slideEntries = [];
  const slideRelEntries = [];
  const imageEntries = [];
  const slideIdEntries = [];
  const presentationRelEntries = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];

  slides.forEach((slide, index) => {
    const slideNo = index + 1;
    const imagePath = slide.imagePath && fs.existsSync(slide.imagePath) ? slide.imagePath : null;
    const mediaName = imagePath ? `slide${slideNo}${fileExt(imagePath) || '.png'}` : '';

    slideIdEntries.push(`<p:sldId id="${255 + slideNo}" r:id="rId${slideNo + 1}"/>`);
    presentationRelEntries.push(`<Relationship Id="rId${slideNo + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`);

    slideEntries.push({
      name: `ppt/slides/slide${slideNo}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${imagePath ? `
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="Board ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>` : ''}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    });

    slideRelEntries.push({
      name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${imagePath ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${mediaName}"/>` : ''}
</Relationships>`,
    });

    if (imagePath) {
      imageEntries.push({ name: `ppt/media/${mediaName}`, data: fs.readFileSync(imagePath) });
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
    { name: 'ppt/theme/theme1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Service06Boards"><a:themeElements><a:clrScheme name="Service06Boards"><a:dk1><a:srgbClr val="1A3554"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0F172A"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="DFAF67"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="6366F1"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Service06Boards"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Service06Boards"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>` },
    { name: 'ppt/presProps.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    { name: 'ppt/viewProps.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>` },
    { name: 'ppt/tableStyles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def=""/>` },
    ...slideEntries,
    ...slideRelEntries,
    ...imageEntries,
  ];

  fs.writeFileSync(outPath, createStoredZip(entries));
}

async function buildArchitecturalPresentationPackage(subject, context, assets, outPath, boardsDir, options = {}) {
  const assetIndex = buildPresentationAssetIndex(assets);
  const plan = buildArchitecturalDeckPlan(subject, assetIndex, context, options);
  const slides = await buildPresentationBoardsFromPlan(plan, subject, assetIndex, context, boardsDir, options);
  await buildImageBoardPptx(slides, subject.name, outPath);
  return {
    pptxPath: outPath,
    boardsDir,
    slideCount: slides.length,
    boardImages: slides.map(slide => slide.imagePath),
    provider: replicate && parseBooleanLike(options.enableNanoBanana, true) ? 'replicate+nano-banana-2 + local-board-layout' : 'local-board-layout',
    model: replicate && parseBooleanLike(options.enableNanoBanana, true) ? SERVICE_06_BOARD_IMAGE_MODEL : 'local-architectural-board-composer-v1',
  };
}

async function buildWordDossier(dossier, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const lang = context.brand.languageMode;
  const rtlLike = isRtlLanguage(lang);
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;
  const lbl = (en, ar) => labelForLanguage(en, ar, lang);
  const sections = (dossier.sections || []).filter(hasRenderableSection);
  const buildingRecords = (dossier.buildingRecords || []).filter(hasRenderableBuildingRecord);
  const references = (dossier.references || []).filter(hasRenderableReference);
  const appendices = (dossier.appendices || []).map(item => normalizeText(item)).filter(Boolean);
  const coverageLines = buildCoverageSummaryLines(dossier.coverage || {}, lang);
  const projectWideAssets = collectProjectWideAssetGroups(context);
  const historicalNarrative = getHistoricalNarrative(context);
  const projectWideServiceChapters = getOrderedServiceDossierChapters(projectWideAssets, lang, {
    scope: 'project',
    historicalNarrative,
  });
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

  const wordHeading = (text, level, opts = {}) => createWordParagraph(text, context, {
    heading: level,
    alignment: paragraphAlign,
    bold: true,
    ...opts,
  });

  const wordBody = text => {
    children.push(...createWordNarrativeParagraphs(text, context, { alignment: paragraphAlign }));
  };

  const wordAssetLine = asset => createWordParagraph(`- ${formatAssetReference(asset, lang)}`, context, {
    alignment: paragraphAlign,
    spacing: { line: 320, before: 20, after: 40 },
  });

  const wordAssetList = assets => {
    assets.forEach(asset => children.push(wordAssetLine(asset)));
  };

  const wordImageRun = async (assetPath, width = 380) => {
    const renderPath = await resolveRenderableImagePath(assetPath, path.dirname(outPath), {
      forcePng: true,
      suffix: 'word_asset',
    });
    if (!ImageRun || !renderPath || !fs.existsSync(renderPath)) return null;
    try {
      const data = fs.readFileSync(renderPath);
      const ext = fileExt(renderPath).replace('.', '');
      const typeMap = { jpg: 'jpg', jpeg: 'jpg', png: 'png' };
      return new ImageRun({
        data,
        type: typeMap[ext] || 'png',
        transformation: { width, height: Math.round(width * 0.6) },
      });
    } catch (error) {
      return null;
    }
  };

  const wordImageParagraph = async (assetPath, caption, width = 380) => {
    const run = await wordImageRun(assetPath, width);
    if (!run) return;
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 40 },
      children: [run],
    }));
    if (caption) {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: caption, size: 18, color: '475569', italics: true })],
      }));
    }
  };

  const pushAssetChapter = async (title, intro, imageAssets = [], fileAssets = [], options = {}) => {
    if (!hasRenderableText(intro) && !imageAssets.length && !fileAssets.length) return;
    children.push(wordHeading(title, options.level || HeadingLevel.HEADING_2, {
      spacing: options.spacing || { before: 180, after: 80 },
    }));
    if (hasRenderableText(intro)) wordBody(intro);
    for (const asset of imageAssets) {
      await wordImageParagraph(asset.copiedPath, asset.name, options.imageWidth || 380);
    }
    if (fileAssets.length) wordAssetList(fileAssets);
  };

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
  children.push(createWordParagraph(`${lbl('Implementing Body', 'الجهة المنفذة')}: ${context.brand.implementingBody}`, context, {
    alignment: paragraphAlign,
  }));
  children.push(createWordParagraph(`${lbl('Preparation Date', 'تاريخ الإعداد')}: ${context.brand.preparationDate}`, context, {
    alignment: paragraphAlign,
  }));
  children.push(createWordParagraph(`${lbl('Consultant Team', 'الفريق الاستشاري')}: ${context.brand.consultantTeam}`, context, {
    alignment: paragraphAlign,
    spacing: { after: 240 },
  }));
  children.push(wordHeading(lbl('Executive Summary', 'الملخص التنفيذي'), HeadingLevel.HEADING_1));
  wordBody(dossier.executiveSummary);

  if (hasRenderableText(dossier.methodology)) {
    children.push(wordHeading(lbl('Methodology', 'المنهجية'), HeadingLevel.HEADING_1));
    wordBody(dossier.methodology);
  }

  if (coverageLines.length) {
    children.push(wordHeading(lbl('Coverage Summary', 'ملخص التغطية'), HeadingLevel.HEADING_1));
    coverageLines.forEach(line => {
      children.push(createWordParagraph(`- ${line}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 20, after: 50 },
      }));
    });
  }

  if (sections.length) {
    children.push(wordHeading(lbl('Table of Contents', 'جدول المحتويات'), HeadingLevel.HEADING_1));
    sections.forEach((section, index) => {
      children.push(createWordParagraph(`${index + 1}. ${section.title}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 40, after: 40 },
      }));
    });

    sections.forEach(section => {
      children.push(wordHeading(section.title, HeadingLevel.HEADING_1, {
        spacing: { before: 180, after: 80 },
      }));
      wordBody(section.body);
    });
  }

  if (projectWideServiceChapters.length) {
    children.push(wordHeading(lbl('Project-Wide Linked Material', 'المواد المرتبطة على مستوى المشروع'), HeadingLevel.HEADING_1, {
      spacing: { before: 180, after: 80 },
    }));
    wordBody(lbl(
      'Project-level assets that are not attached to a single building are included here so the main dossier carries the full study record alongside the building chapters.',
      'تدرج هنا الأصول المرتبطة بالمشروع ككل وغير المرتبطة بمبنى واحد حتى تحمل الوثيقة الرئيسية سجل الدراسة الكامل إلى جانب فصول المباني.',
    ));
    for (const chapter of projectWideServiceChapters) {
      await pushAssetChapter(chapter.title, chapter.intro, chapter.imageAssets, chapter.fileAssets);
    }
  }

  if (buildingRecords.length) {
    children.push(wordHeading(lbl('Building Documentation', 'توثيق المباني'), HeadingLevel.HEADING_1, {
      spacing: { before: 180, after: 80 },
    }));
    for (let index = 0; index < buildingRecords.length; index += 1) {
      const building = buildingRecords[index];
      const assetGroups = collectDossierAssetGroups(building.assets || []);
      children.push(wordHeading(`${index + 1}. ${building.name}`, HeadingLevel.HEADING_2, {
        spacing: { before: 180, after: 70 },
      }));
      wordBody(building.summary);
      if (assetGroups.heroImage) {
        await wordImageParagraph(assetGroups.heroImage.copiedPath, assetGroups.heroImage.name, 430);
      }
      const buildingServiceChapters = getOrderedServiceDossierChapters(assetGroups, lang, {
        scope: 'building',
        historicalNarrative,
      });
      for (const chapter of buildingServiceChapters) {
        await pushAssetChapter(chapter.title, chapter.intro, chapter.imageAssets, chapter.fileAssets);
      }
    }
  }

  if (references.length) {
    children.push(wordHeading(lbl('References', 'المراجع'), HeadingLevel.HEADING_1, {
      spacing: { before: 180, after: 80 },
    }));
    references.forEach(ref => {
      children.push(createWordParagraph(`${ref.title} - ${ref.note}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 20, after: 60 },
      }));
    });
  }

  if (appendices.length) {
    children.push(wordHeading(lbl('Appendices', 'الملاحق'), HeadingLevel.HEADING_1, {
      spacing: { before: 180, after: 80 },
    }));
    appendices.forEach(item => {
      children.push(createWordParagraph(`- ${item}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 20, after: 40 },
      }));
    });
  }

  const dossierDoc = new Document({
    creator: 'Codex',
    title: dossier.title,
    sections: [{ properties: {}, children }],
  });
  const dossierBuffer = await Packer.toBuffer(dossierDoc);
  fs.writeFileSync(outPath, dossierBuffer);
  return;

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
    `${labelForLanguage('Implementing Body', 'الجف‡ة المنفذة', context.brand.languageMode)}: ${context.brand.implementingBody}`,
    context,
    { alignment: paragraphAlign },
  ));
  children.push(createWordParagraph(
    `${labelForLanguage('Preparation Date', 'تاريخ الإعداد', context.brand.languageMode)}: ${context.brand.preparationDate}`,
    context,
    { alignment: paragraphAlign },
  ));
  children.push(createWordParagraph(
    `${labelForLanguage('Consultant Team', 'الفريف‚ الاستشاري', context.brand.languageMode)}: ${context.brand.consultantTeam}`,
    context,
    { alignment: paragraphAlign, spacing: { after: 240 } },
  ));
  children.push(createWordParagraph(labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode), context, {
    heading: HeadingLevel.HEADING_1,
    alignment: paragraphAlign,
    bold: true,
  }));
  children.push(...createWordNarrativeParagraphs(dossier.executiveSummary, context, { alignment: paragraphAlign }));
  if (hasRenderableText(dossier.methodology)) {
    children.push(createWordParagraph(labelForLanguage('Methodology', 'المنف‡جية', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
    }));
    children.push(...createWordNarrativeParagraphs(dossier.methodology, context, { alignment: paragraphAlign }));
  }
  if (sections.length) {
    children.push(createWordParagraph(labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
    }));
    sections.forEach((section, index) => {
      children.push(createWordParagraph(`${index + 1}. ${section.title}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 40, after: 40 },
      }));
    });

    sections.forEach(section => {
      children.push(createWordParagraph(section.title, context, {
        heading: HeadingLevel.HEADING_1,
        alignment: paragraphAlign,
        bold: true,
        spacing: { before: 180, after: 80 },
      }));
      children.push(...createWordNarrativeParagraphs(section.body, context, { alignment: paragraphAlign }));
    });
  }

  if (buildingRecords.length) {
    children.push(createWordParagraph(labelForLanguage('Building Documentation', 'توثيف‚ المباني', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
      spacing: { before: 180, after: 80 },
    }));
    buildingRecords.forEach((building, index) => {
      children.push(createWordParagraph(`${index + 1}. ${building.name}`, context, {
        heading: HeadingLevel.HEADING_2,
        alignment: paragraphAlign,
        bold: true,
      }));
      children.push(...createWordNarrativeParagraphs(building.summary, context, { alignment: paragraphAlign }));
    });
  }

  if (references.length) {
    children.push(createWordParagraph(labelForLanguage('References', 'المراجع', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
      spacing: { before: 180, after: 80 },
    }));
    references.forEach(ref => {
      children.push(createWordParagraph(`${ref.title} - ${ref.note}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 20, after: 60 },
      }));
    });
  }

  if (appendices.length) {
    children.push(createWordParagraph(labelForLanguage('Appendices', 'الملاحف‚', context.brand.languageMode), context, {
      heading: HeadingLevel.HEADING_1,
      alignment: paragraphAlign,
      bold: true,
      spacing: { before: 180, after: 80 },
    }));
    appendices.forEach(item => {
      children.push(createWordParagraph(`- ${item}`, context, {
        alignment: paragraphAlign,
        spacing: { line: 320, before: 20, after: 40 },
      }));
    });
  }

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
    const usedPages = new Set();
    const markPageUsed = pageIndex => usedPages.add(pageIndex);
    const ensureSpace = minHeight => {
      if (doc.y + minHeight > pageBottom()) doc.addPage();
    };
    const startSection = (minHeight = 72, spacingBefore = 0.9) => {
      const spacingHeight = spacingBefore > 0 ? spacingBefore * 14 : 0;
      ensureSpace(minHeight + spacingHeight);
      if (spacingBefore > 0) doc.moveDown(spacingBefore);
    };
    const sections = (dossier.sections || []).filter(hasRenderableSection);
    const buildingRecords = (dossier.buildingRecords || []).filter(hasRenderableBuildingRecord);
    const references = (dossier.references || []).filter(hasRenderableReference);
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

      const lang = context.brand.languageMode;
      const lbl = (en, ar) => labelForLanguage(en, ar, lang);
      const coverageLines = buildCoverageSummaryLines(dossier.coverage || {}, lang);
      const projectWideAssets = collectProjectWideAssetGroups(context);
      const historicalNarrative = getHistoricalNarrative(context);
      const projectWideServiceChapters = getOrderedServiceDossierChapters(projectWideAssets, lang, {
        scope: 'project',
        historicalNarrative,
      });

      const embedPdfImage = async (imgPath, opts = {}) => {
        const renderPath = await resolveRenderableImagePath(imgPath, path.dirname(outPath), {
          forcePng: true,
          suffix: 'pdf_asset',
        });
        if (!renderPath || !fs.existsSync(renderPath)) return;
        try {
          const maxH = opts.maxH || 200;
          const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          ensureSpace(maxH + 30);
          capturePdfPages(doc, () => doc.image(renderPath, {
            fit: [maxW, maxH],
            align: 'center',
          }), markPageUsed);
          doc.moveDown(0.35);
          if (opts.caption) {
            capturePdfPages(doc, () => {
              setPdfFont(doc, false, context.brand.typography)
                .fontSize(8.5)
                .fillColor('#64748b')
                .text(formatPdfText(opts.caption, lang), { align: 'center' });
            }, markPageUsed);
            doc.moveDown(0.25);
          }
        } catch (error) {
          // Ignore broken images and continue.
        }
      };

      const writePdfAssetLine = asset => {
        ensureSpace(20);
        const lineText = asset?.copiedPath || asset?.relativePath || asset?.type
          ? `- ${formatAssetReference(asset, lang)}`
          : `- ${normalizeText(asset?.name)}`;
        capturePdfPages(doc, () => {
          setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155').text(
            formatPdfText(lineText, lang),
            {
              align: prefersRtlText(normalizeText(asset?.name, lineText), lang, { preferDocumentDirection: true }) ? 'right' : 'left',
            },
          );
        }, markPageUsed);
      };

      const pushPdfAssetChapter = async (title, intro, imageAssets = [], fileAssets = [], options = {}) => {
        if (!hasRenderableText(intro) && !imageAssets.length && !fileAssets.length) return;
        startSection(options.minHeight || 64, options.spacingBefore ?? 0.75);
        writePdfSectionHeading(doc, title, context, {
          fontSize: options.fontSize || 12.5,
          color: options.color || '#0f172a',
          onPageUsed: markPageUsed,
        });
        if (hasRenderableText(intro)) {
          writePdfParagraphs(doc, intro, context, {
            ltrAlign: 'justify',
            paragraphGap: 0.35,
            onPageUsed: markPageUsed,
          });
        }
        for (const asset of imageAssets) {
          await embedPdfImage(asset.copiedPath, {
            maxH: options.imageMaxH || 210,
            caption: asset.name,
          });
        }
        fileAssets.forEach(writePdfAssetLine);
      };

      capturePdfPages(doc, () => {
        setPdfFont(doc, true, context.brand.typography)
          .fontSize(25)
          .fillColor(context.brand.primaryColor)
          .text(formatPdfText(dossier.title, lang), { align: 'center' });
      }, markPageUsed);
      doc.moveDown(0.35);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography)
          .fontSize(15)
          .fillColor('#334155')
          .text(formatPdfText(dossier.subtitle, lang), { align: 'center' });
      }, markPageUsed);
      doc.moveDown(0.2);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography)
          .fontSize(10)
          .fillColor('#475569')
          .text(formatPdfText(`${context.brand.implementingBody} | ${context.brand.preparationDate}`, lang), { align: 'center' });
      }, markPageUsed);
      doc.moveDown(0.3);
      capturePdfPages(doc, () => {
        setPdfFont(doc, false, context.brand.typography)
          .fontSize(10)
          .fillColor('#64748b')
          .text(formatPdfText(`${lbl('Consultant Team', 'الفريق الاستشاري')}: ${context.brand.consultantTeam}`, lang), { align: 'center' });
      }, markPageUsed);

      if (images[0]?.path && fs.existsSync(images[0].path)) {
        doc.moveDown(0.8);
        await embedPdfImage(images[0].path, { maxH: 215, caption: images[0].caption || '' });
      }

      startSection(88, 1);
      writePdfSectionHeading(doc, lbl('Executive Summary', 'الملخص التنفيذي'), context, {
        color: '#0f172a',
        onPageUsed: markPageUsed,
      });
      writePdfParagraphs(doc, dossier.executiveSummary, context, {
        ltrAlign: 'justify',
        onPageUsed: markPageUsed,
      });

      if (hasRenderableText(dossier.methodology)) {
        startSection(88, 0.7);
        writePdfSectionHeading(doc, lbl('Methodology', 'المنهجية'), context, {
          color: '#0f172a',
          onPageUsed: markPageUsed,
        });
        writePdfParagraphs(doc, dossier.methodology, context, {
          ltrAlign: 'justify',
          onPageUsed: markPageUsed,
        });
      }

      if (coverageLines.length) {
        startSection(80, 0.7);
        writePdfSectionHeading(doc, lbl('Coverage Summary', 'ملخص التغطية'), context, {
          color: '#0f172a',
          onPageUsed: markPageUsed,
        });
        coverageLines.forEach(line => writePdfAssetLine({ name: line }));
      }

      if (sections.length) {
        startSection(80, 0.7);
        writePdfSectionHeading(doc, lbl('Table of Contents', 'جدول المحتويات'), context, {
          color: '#0f172a',
          fontSize: 13,
          onPageUsed: markPageUsed,
        });
        sections.forEach((section, index) => {
          ensureSpace(20);
          capturePdfPages(doc, () => {
            setPdfFont(doc, false, context.brand.typography).fontSize(10).fillColor('#334155').text(
              formatPdfText(`${index + 1}. ${section.title}`, lang),
              {
                align: prefersRtlText(section.title, lang, { preferDocumentDirection: true }) ? 'right' : 'left',
                indent: 10,
              },
            );
          }, markPageUsed);
        });

        for (const section of sections) {
          startSection(72, 0.9);
          writePdfSectionHeading(doc, section.title, context, { onPageUsed: markPageUsed });
          writePdfParagraphs(doc, section.body, context, {
            ltrAlign: 'justify',
            onPageUsed: markPageUsed,
          });
        }
      }

      if (projectWideServiceChapters.length) {
        startSection(84, 0.9);
        writePdfSectionHeading(doc, lbl('Project-Wide Linked Material', 'المواد المرتبطة على مستوى المشروع'), context, {
          onPageUsed: markPageUsed,
        });
        writePdfParagraphs(doc, lbl(
          'Project-level assets that are not attached to a single building are included here so the main dossier carries the full study record alongside the building chapters.',
          'تدرج هنا الأصول المرتبطة بالمشروع ككل وغير المرتبطة بمبنى واحد حتى تحمل الوثيقة الرئيسية سجل الدراسة الكامل إلى جانب فصول المباني.',
        ), context, {
          ltrAlign: 'justify',
          onPageUsed: markPageUsed,
        });
        for (const chapter of projectWideServiceChapters) {
          await pushPdfAssetChapter(chapter.title, chapter.intro, chapter.imageAssets, chapter.fileAssets);
        }
      }

      if (buildingRecords.length) {
        startSection(84, 0.9);
        writePdfSectionHeading(doc, lbl('Building Documentation', 'توثيق المباني'), context, {
          onPageUsed: markPageUsed,
        });
        for (let index = 0; index < buildingRecords.length; index += 1) {
          const building = buildingRecords[index];
          const assetGroups = collectDossierAssetGroups(building.assets || []);
          startSection(64, 0.75);
          capturePdfPages(doc, () => {
            setPdfFont(doc, true, context.brand.typography).fontSize(11.5).fillColor('#0f172a').text(
              formatPdfText(`${index + 1}. ${building.name}`, lang),
              {
                align: prefersRtlText(building.name, lang, { preferDocumentDirection: true }) ? 'right' : 'left',
              },
            );
          }, markPageUsed);
          doc.moveDown(0.15);
          writePdfParagraphs(doc, building.summary, context, {
            ltrAlign: 'justify',
            paragraphGap: 0.35,
            onPageUsed: markPageUsed,
          });
          if (assetGroups.heroImage) {
            doc.moveDown(0.3);
            await embedPdfImage(assetGroups.heroImage.copiedPath, { maxH: 210, caption: assetGroups.heroImage.name });
          }
          const buildingServiceChapters = getOrderedServiceDossierChapters(assetGroups, lang, {
            scope: 'building',
            historicalNarrative,
          });
          for (const chapter of buildingServiceChapters) {
            await pushPdfAssetChapter(
              chapter.title,
              chapter.intro,
              chapter.imageAssets,
              chapter.fileAssets,
              { fontSize: 11.5, spacingBefore: 0.45 },
            );
          }
        }
      }

      if (references.length) {
        startSection(64, 0.7);
        writePdfSectionHeading(doc, lbl('References', 'المراجع'), context, {
          onPageUsed: markPageUsed,
        });
        references.forEach(ref => {
          ensureSpace(26);
          capturePdfPages(doc, () => {
            setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155').text(
              formatPdfText(`${ref.title} - ${ref.note}`, lang),
              {
                align: prefersRtlText(`${ref.title} ${ref.note}`, lang, { preferDocumentDirection: true }) ? 'right' : 'left',
              },
            );
          }, markPageUsed);
          doc.moveDown(0.15);
        });
      }

      if (appendices.length) {
        startSection(64, 0.6);
        writePdfSectionHeading(doc, lbl('Appendices', 'الملاحق'), context, {
          onPageUsed: markPageUsed,
        });
        appendices.forEach(item => writePdfAssetLine({ name: item }));
      }

      const finalPageCount = trimBufferedPages(doc, usedPages);
      for (let pageIndex = 0; pageIndex < finalPageCount; pageIndex += 1) {
        doc.switchToPage(pageIndex);
        capturePdfPages(doc, () => {
          setPdfFont(doc, false, context.brand.typography).fontSize(8.5).fillColor('#64748b').text(
            formatPdfText(lbl(`Page ${pageIndex + 1} of ${finalPageCount}`, `الصفحة ${pageIndex + 1} من ${finalPageCount}`), lang),
            42,
            doc.page.height - 26,
            { align: 'center', width: doc.page.width - 84 },
          );
        }, markPageUsed);
      }

      doc.end();
      return;

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
        ensureSpace(128);
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
        startSection(72, 0.9);
        writePdfSectionHeading(doc, section.title, context, { onPageUsed: markPageUsed });
        writePdfParagraphs(doc, section.body, context, {
          ltrAlign: 'justify',
          onPageUsed: markPageUsed,
        });
      });

      if (buildingRecords.length) {
        startSection(72, 0.9);
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
        startSection(64, 0.6);
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
function collectZipEntries(rootDir, currentDir = rootDir, entries = [], excludedPaths = null) {
  const names = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of names) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectZipEntries(rootDir, fullPath, entries, excludedPaths);
      continue;
    }
    const resolved = path.resolve(fullPath);
    if (excludedPaths && excludedPaths.has(resolved)) continue;
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

  const lang = context.brand.languageMode;
  const rtlLike = isRtlLanguage(lang);
  const paragraphAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
    forcePng: true,
    suffix: 'word_logo',
    maxWidth: 150,
    maxHeight: 64,
  });

  // â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const lbl = (en, ar) => labelForLanguage(en, ar, lang);

  function wordHeading(text, level, opts = {}) {
    return createWordParagraph(text, context, {
      heading: level,
      alignment: paragraphAlign,
      bold: true,
      spacing: { before: 240, after: 100 },
      ...opts,
    });
  }

  function wordBody(text, opts = {}) {
    return createWordNarrativeParagraphs(text, context, { alignment: paragraphAlign, ...opts });
  }

  function wordImageRun(assetPath, width = 380) {
    if (!ImageRun || !fs.existsSync(assetPath)) return null;
    try {
      const data = fs.readFileSync(assetPath);
      const ext = fileExt(assetPath).replace('.', '');
      const typeMap = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'png' };
      return new ImageRun({ data, type: typeMap[ext] || 'png', transformation: { width, height: Math.round(width * 0.6) } });
    } catch { return null; }
  }

  function wordImageParagraph(assetPath, caption, width = 380) {
    const run = wordImageRun(assetPath, width);
    if (!run) return [];
    const items = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 40 },
        children: [run],
      }),
    ];
    if (caption) {
      items.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 100 },
        children: [new TextRun({ text: caption, size: 18, color: '475569', italics: true })],
      }));
    }
    return items;
  }

  // â”€â”€ pick images from building assets by service â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const webImages = building.assets.filter(a => a.copiedPath && isWebReadyImage(fileExt(a.copiedPath)));
  const imgByService = (svc) => webImages.filter(a => a.service === svc);
  const beforeAfterImgs = imgByService(1).slice(0, 6);
  const archDrawings = building.assets.filter(a => a.copiedPath && a.service === 2 && (a.type === 'drawing' || a.usage === 'technical-drawing')).slice(0, 6);
  const archDrawingImages = building.assets.filter(a => a.copiedPath && a.service === 2 && isWebReadyImage(fileExt(a.copiedPath))).slice(0, 6);
  const viz2d3d = [...imgByService(2), ...imgByService(5)].slice(0, 8);
  const historicalImgs = imgByService(4).slice(0, 4);

  // â”€â”€ build children array â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const children = [];

  // Logo
  if (logo && ImageRun && fs.existsSync(logo.path)) {
    try {
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new ImageRun({ data: fs.readFileSync(logo.path), transformation: { width: logo.width, height: logo.height } })],
      }));
    } catch { /* skip broken logo */ }
  }

  // â”€â”€ 1. COVER / TITLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(createWordParagraph(building.name, context, {
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    bold: true,
    size: 34,
    spacing: { after: 120 },
  }));
  children.push(createWordParagraph(context.brand.projectName, context, {
    alignment: AlignmentType.CENTER,
    size: 22,
    color: '1A3554',
    spacing: { after: 60 },
  }));
  children.push(createWordParagraph(
    `${lbl('Prepared by', 'أعدف‡')} ${context.brand.implementingBody}  |  ${context.brand.preparationDate}`,
    context, { alignment: AlignmentType.CENTER, size: 18, color: '475569', spacing: { after: 240 } },
  ));

  // Hero image (first available from any service)
  const heroImg = webImages[0];
  if (heroImg) children.push(...wordImageParagraph(heroImg.copiedPath, '', 480));

  // â”€â”€ 2. ARCHITECTURAL DESCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  children.push(wordHeading(lbl('Architectural Description', 'الوصف المعماري الفƒامل'), HeadingLevel.HEADING_1));
  children.push(...wordBody(building.summary));

  // â”€â”€ 3. BEFORE / AFTER (Service 01) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (beforeAfterImgs.length) {
    children.push(wordHeading(lbl('Before / After Photos', 'صور ف‚بل / بعد'), HeadingLevel.HEADING_1));
    children.push(...wordBody(lbl(
      'Restored imagery produced through the visual intelligence phase, showing condition before and after restoration work.',
      'صور معالفŽجة تُنتجف‡ا مرحلة الذفƒاء البصريي تُظف‡ر حالة المبنف‰ ف‚بل وبعد أعمال الترميم.',
    )));
    for (const img of beforeAfterImgs) {
      children.push(...wordImageParagraph(img.copiedPath, img.name, 380));
    }
  }

  // â”€â”€ 4. ARCHITECTURAL DRAWINGS (Service 02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const drawingSources = [...archDrawings, ...archDrawingImages];
  if (drawingSources.length) {
    children.push(wordHeading(lbl('Architectural Drawings', 'المخططات المعمارية (مساف‚طي واجف‡اتي مف‚اطع)'), HeadingLevel.HEADING_1));
    children.push(...wordBody(lbl(
      'Plans, facades, and sections produced through the architectural rehabilitation visualization phase.',
      'المساف‚ط والواجف‡ات والمف‚اطع المُنتجة عبر مرحلة تصور إعادة التأف‡يل المعماري.',
    )));
    for (const item of drawingSources.slice(0, 6)) {
      if (item.copiedPath && isWebReadyImage(fileExt(item.copiedPath))) {
        children.push(...wordImageParagraph(item.copiedPath, item.name, 420));
      } else {
        children.push(createWordParagraph(`- ${item.name}`, context, { alignment: paragraphAlign }));
      }
    }
  }

  // â”€â”€ 5. 2D / 3D VISUALIZATIONS (Service 02 + 05) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (viz2d3d.length) {
    children.push(wordHeading(lbl('2D & 3D Visualizations', 'التصورات ثنائية وثلاثية الأبعاد'), HeadingLevel.HEADING_1));
    children.push(...wordBody(lbl(
      'Rendered visualizations and three-dimensional outputs produced for this building across the project phases.',
      'التصورات المُصيفŽف‘رة والمخرجات ثلاثية الأبعاد المُنتجة لف‡ذا المبنف‰ عبر مراحل المشروع.',
    )));
    for (const img of viz2d3d) {
      children.push(...wordImageParagraph(img.copiedPath, img.name, 380));
    }
  }

  // â”€â”€ 6. HISTORICAL ANALYSIS (Service 04) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const s4JobForBuilding = context.linkedJobs?.find(j => j.service === 4) || null;
  const historicalNarrative = s4JobForBuilding?.metadata?.project?.description
    || s4JobForBuilding?.metadata?.summary
    || lbl(
      'Historical analysis was prepared as part of the academic reporting phase. Refer to the linked reports for full narrative detail.',
      'أُعد التحليل التاريخي ضمن مرحلة إعداد التف‚ارير الأفƒاديمية. ارجع إلف‰ التف‚ارير المرتبطة للاطلاع علف‰ التفاصيل السردية الفƒاملة.',
    );
  children.push(wordHeading(lbl('Historical Analysis', 'التحليل التاريخي'), HeadingLevel.HEADING_1));
  children.push(...wordBody(historicalNarrative));
  for (const img of historicalImgs) {
    children.push(...wordImageParagraph(img.copiedPath, img.name, 380));
  }

  // â”€â”€ 7. REHABILITATION PLAN (Service 02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const s2Reports = building.assets.filter(a => a.service === 2 && (a.type === 'report' || a.usage === 'documentation')).slice(0, 6);
  children.push(wordHeading(lbl('Rehabilitation Plan', 'خطة التأف‡يل'), HeadingLevel.HEADING_1));
  children.push(...wordBody(lbl(
    'The rehabilitation strategy for this building was developed through the architectural phase, incorporating condition assessment, structural analysis, and restoration methodology.',
    'وُضعت استراتيجية التأف‡يل لف‡ذا المبنف‰ في إطار المرحلة المعماريةي وتشمل تف‚ييم الحالة والتحليل الإنشائي ومنف‡جية الترميم.',
  )));
  for (const item of s2Reports) {
    children.push(createWordParagraph(`- ${item.name}`, context, { alignment: paragraphAlign }));
  }
  if (!s2Reports.length) {
    children.push(...wordBody(lbl(
      'Detailed rehabilitation plans will be incorporated when additional architectural outputs are linked to this building record.',
      'ستُدرج خطط التأف‡يل التفصيلية عند ربط مخرجات معمارية إضافية بسجل ف‡ذا المبنف‰.',
    )));
  }

  // â”€â”€ BUILD DOC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const doc = new Document({ creator: 'Codex', title: building.name, sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}


async function buildPdfBuildingDocument(building, context, imagePath, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const lang = context.brand.languageMode;
    const rtlLike = isRtlLanguage(lang);
    const align = rtlLike ? 'right' : 'left';
    const usedPages = new Set([0]);
    const markPageUsed = idx => usedPages.add(idx);
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 28;
    const ensureSpace = minH => {
      if (doc.y + minH > pageBottom()) {
        doc.addPage();
        markPageUsed(doc.bufferedPageRange().count - 1);
      }
    };
    const lbl = (en, ar) => labelForLanguage(en, ar, lang);

    // â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function sectionHeading(text, opts = {}) {
      ensureSpace(60);
      writePdfSectionHeading(doc, text, context, { color: '#0f172a', ...opts, onPageUsed: markPageUsed });
    }

    function sectionBody(text, opts = {}) {
      writePdfParagraphs(doc, text, context, { align: rtlLike ? 'right' : 'justify', ...opts, onPageUsed: markPageUsed });
    }

    function embedImage(imgPath, opts = {}) {
      if (!imgPath || !fs.existsSync(imgPath)) return;
      try {
        const maxH = opts.maxH || 200;
        const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        ensureSpace(maxH + 20);
        capturePdfPages(doc, () => doc.image(imgPath, {
          fit: [maxW, maxH],
          align: 'center',
        }), markPageUsed);
        doc.moveDown(0.4);
        if (opts.caption) {
          capturePdfPages(doc, () => setPdfFont(doc, false, context.brand.typography)
            .fontSize(8).fillColor('#64748b').text(formatPdfText(opts.caption, lang), { align: 'center' }), markPageUsed);
          doc.moveDown(0.3);
        }
      } catch { /* skip broken image */ }
    }

    // â”€â”€ classify building assets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const webImgs = building.assets.filter(a => a.copiedPath && isWebReadyImage(fileExt(a.copiedPath)));
    const imgBySvc = svc => webImgs.filter(a => a.service === svc);
    const beforeAfterImgs = imgBySvc(1).slice(0, 6);
    const s2Drawings = building.assets.filter(a => a.copiedPath && a.service === 2 && (a.type === 'drawing' || a.usage === 'technical-drawing')).slice(0, 6);
    const s2DrawingImages = building.assets.filter(a => a.copiedPath && a.service === 2 && isWebReadyImage(fileExt(a.copiedPath))).slice(0, 6);
    const viz2d3d = [...imgBySvc(2), ...imgBySvc(5)].slice(0, 8);
    const historicalImgs = imgBySvc(4).slice(0, 4);
    const s2Reports = building.assets.filter(a => a.service === 2 && (a.type === 'report' || a.usage === 'documentation')).slice(0, 6);
    const heroImg = webImgs[0];

    (async () => {
      const logo = await prepareLogoPlacement(context.brand.logoPath, path.dirname(outPath), {
        suffix: 'pdf_logo', maxWidth: 150, maxHeight: 64,
      });

      // â”€â”€ COVER PAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (logo) {
        try {
          const logoX = (doc.page.width - logo.width) / 2;
          capturePdfPages(doc, () => doc.image(logo.path, logoX, doc.y, { width: logo.width, height: logo.height }), markPageUsed);
          doc.y = doc.y + logo.height + 14;
        } catch { /* skip */ }
      }

      // Cover: full-width hero image
      if (heroImg) {
        embedImage(heroImg.copiedPath, { maxH: 240 });
        doc.moveDown(0.4);
      } else if (imagePath && fs.existsSync(imagePath)) {
        embedImage(imagePath, { maxH: 240 });
        doc.moveDown(0.4);
      }

      capturePdfPages(doc, () =>
        setPdfFont(doc, true, context.brand.typography)
          .fontSize(26).fillColor(context.brand.primaryColor)
          .text(formatPdfText(building.name, lang), { align: 'center' }),
        markPageUsed,
      );
      doc.moveDown(0.25);
      capturePdfPages(doc, () =>
        setPdfFont(doc, false, context.brand.typography)
          .fontSize(11).fillColor('#334155')
          .text(formatPdfText(context.brand.projectName, lang), { align: 'center' }),
        markPageUsed,
      );
      doc.moveDown(0.2);
      capturePdfPages(doc, () =>
        setPdfFont(doc, false, context.brand.typography)
          .fontSize(9).fillColor('#64748b')
          .text(formatPdfText(`${lbl('Prepared by', 'أعدف‡')} ${context.brand.implementingBody}  |  ${context.brand.preparationDate}`, lang), { align: 'center' }),
        markPageUsed,
      );

      // â”€â”€ 1. ARCHITECTURAL DESCRIPTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      doc.addPage();
      markPageUsed(doc.bufferedPageRange().count - 1);
      sectionHeading(lbl('Architectural Description', 'الوصف المعماري الفƒامل'));
      doc.moveDown(0.2);
      sectionBody(building.summary);

      // â”€â”€ 2. BEFORE / AFTER PHOTOS (Service 01) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (beforeAfterImgs.length) {
        doc.moveDown(0.8);
        sectionHeading(lbl('Before / After Photos', 'صور ف‚بل / بعد'));
        doc.moveDown(0.2);
        sectionBody(lbl(
          'Restored imagery produced through the visual intelligence phase, showing condition before and after restoration work.',
          'صور معالفŽجة تُنتجف‡ا مرحلة الذفƒاء البصريي تُظف‡ر حالة المبنف‰ ف‚بل وبعد أعمال الترميم.',
        ));
        doc.moveDown(0.5);
        for (const img of beforeAfterImgs) {
          embedImage(img.copiedPath, { maxH: 210, caption: img.name });
          doc.moveDown(0.3);
        }
      }

      // â”€â”€ 3. ARCHITECTURAL DRAWINGS (Service 02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const allDrawings = [...s2Drawings, ...s2DrawingImages];
      if (allDrawings.length) {
        doc.moveDown(0.8);
        sectionHeading(lbl('Architectural Drawings', 'المخططات المعمارية (مساف‚طي واجف‡اتي مف‚اطع)'));
        doc.moveDown(0.2);
        sectionBody(lbl(
          'Plans, facades, and sections produced through the architectural rehabilitation visualization phase.',
          'المساف‚ط والواجف‡ات والمف‚اطع المُنتجة عبر مرحلة تصور إعادة التأف‡يل المعماري.',
        ));
        doc.moveDown(0.5);
        for (const item of allDrawings.slice(0, 6)) {
          if (item.copiedPath && isWebReadyImage(fileExt(item.copiedPath))) {
            embedImage(item.copiedPath, { maxH: 230, caption: item.name });
          } else {
            ensureSpace(16);
            capturePdfPages(doc, () =>
              setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155')
                .text(formatPdfText(`- ${item.name}`, lang), { align }),
              markPageUsed,
            );
          }
          doc.moveDown(0.3);
        }
      }

      // â”€â”€ 4. 2D / 3D VISUALIZATIONS (Service 02 + 05) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (viz2d3d.length) {
        doc.moveDown(0.8);
        sectionHeading(lbl('2D & 3D Visualizations', 'التصورات ثنائية وثلاثية الأبعاد'));
        doc.moveDown(0.2);
        sectionBody(lbl(
          'Rendered visualizations and three-dimensional outputs produced for this building across the project phases.',
          'التصورات المُصيفŽف‘رة والمخرجات ثلاثية الأبعاد المُنتجة لف‡ذا المبنف‰ عبر مراحل المشروع.',
        ));
        doc.moveDown(0.5);
        for (const img of viz2d3d) {
          embedImage(img.copiedPath, { maxH: 200, caption: img.name });
          doc.moveDown(0.3);
        }
      }

      // â”€â”€ 5. HISTORICAL ANALYSIS (Service 04) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      doc.moveDown(0.8);
      sectionHeading(lbl('Historical Analysis', 'التحليل التاريخي'));
      doc.moveDown(0.2);
      const s4Job = context.linkedJobs?.find(j => j.service === 4) || null;
      const historicalNarrative = s4Job?.metadata?.project?.description
        || s4Job?.metadata?.summary
        || lbl(
          'Historical analysis was prepared as part of the academic reporting phase. Refer to linked reports for full narrative detail.',
          'أُعد التحليل التاريخي ضمن مرحلة إعداد التف‚ارير الأفƒاديمية. ارجع إلف‰ التف‚ارير المرتبطة للاطلاع علف‰ التفاصيل السردية الفƒاملة.',
        );
      sectionBody(historicalNarrative);
      doc.moveDown(0.5);
      for (const img of historicalImgs) {
        embedImage(img.copiedPath, { maxH: 200, caption: img.name });
        doc.moveDown(0.3);
      }

      // â”€â”€ 6. REHABILITATION PLAN (Service 02) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      doc.moveDown(0.8);
      sectionHeading(lbl('Rehabilitation Plan', 'خطة التأف‡يل'));
      doc.moveDown(0.2);
      sectionBody(lbl(
        'The rehabilitation strategy for this building was developed through the architectural phase, incorporating condition assessment, structural analysis, and restoration methodology.',
        'وُضعت استراتيجية التأف‡يل لف‡ذا المبنف‰ في إطار المرحلة المعماريةي وتشمل تف‚ييم الحالة والتحليل الإنشائي ومنف‡جية الترميم.',
      ));
      if (s2Reports.length) {
        doc.moveDown(0.4);
        for (const item of s2Reports) {
          ensureSpace(16);
          capturePdfPages(doc, () =>
            setPdfFont(doc, false, context.brand.typography).fontSize(9.5).fillColor('#334155')
              .text(formatPdfText(`- ${item.name}`, lang), { align }),
            markPageUsed,
          );
        }
      } else {
        doc.moveDown(0.3);
        sectionBody(lbl(
          'Detailed rehabilitation plans will be incorporated when additional architectural outputs are linked to this building record.',
          'ستُدرج خطط التأف‡يل التفصيلية عند ربط مخرجات معمارية إضافية بسجل ف‡ذا المبنف‰.',
        ));
      }

      // â”€â”€ PAGE NUMBERS + TRIM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const totalPages = trimTrailingBufferedPages(doc, usedPages);
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        capturePdfPages(doc, () =>
          setPdfFont(doc, false, context.brand.typography).fontSize(8).fillColor('#94a3b8')
            .text(
              formatPdfText(lbl(`${building.name}  -  Page ${i + 1} of ${totalPages}`, `${building.name}  -  الصفحة ${i + 1} من ${totalPages}`), lang),
              42, doc.page.height - 26, { width: doc.page.width - 84, align: 'center' },
            ),
          markPageUsed,
        );
      }

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
    aiModel: context.ai?.modelLabel || 'GPT 5',
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

function safeSheetName(name) {
  // Excel worksheet names cannot contain: / \ ? * [ ] and must be <= 31 chars.
  return String(name || 'Sheet')
    .replace(/[/\\?*[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
}

async function buildExcelManifest(context, dossier, contentModel, deliverables, outPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_06_NAME;
  workbook.created = new Date();

  const languageMode = context.brand.languageMode;
  const summary = workbook.addWorksheet(safeSheetName(labelForLanguage('Project Summary', 'ملخص المشروع', languageMode)));
  summary.columns = [
    { header: labelForLanguage('Field', 'الحف‚ل', languageMode), width: 28 },
    { header: labelForLanguage('Value', 'الف‚يمة', languageMode), width: 70 },
  ];
  [
    [labelForLanguage('Project Name', 'اسم المشروع', languageMode), context.brand.projectName],
    [labelForLanguage('Implementing Body', 'الجف‡ة المنفذة', languageMode), context.brand.implementingBody],
    [labelForLanguage('Preparation Date', 'تاريخ الإعداد', languageMode), context.brand.preparationDate],
    [labelForLanguage('Consultant Team', 'الفريف‚ الاستشاري', languageMode), context.brand.consultantTeam],
    [labelForLanguage('Language Mode', 'لغة الإخراج', languageMode), localizedLanguageMode(context.brand.languageMode, languageMode)],
    [labelForLanguage('Assets Indexed', 'الأصول المفف‡رسة', languageMode), contentModel.counts.totalAssets],
    [labelForLanguage('Images', 'الصور', languageMode), contentModel.counts.images],
    [labelForLanguage('Reports', 'التف‚ارير', languageMode), contentModel.counts.reports],
    [labelForLanguage('Models', 'النماذج', languageMode), contentModel.counts.models],
    [labelForLanguage('Presentations', 'العروض التف‚ديمية', languageMode), contentModel.counts.presentations],
  ].forEach(row => summary.addRow(row));
  applyWorksheetDirection(summary, languageMode);

  const assets = workbook.addWorksheet(safeSheetName(labelForLanguage('Asset Register', 'سجل الأصول', languageMode)));
  assets.columns = [
    { header: labelForLanguage('Source', 'المصدر', languageMode), width: 28 },
    { header: labelForLanguage('Building', 'المبنف‰', languageMode), width: 28 },
    { header: labelForLanguage('District', 'النطاق', languageMode), width: 28 },
    { header: labelForLanguage('File', 'الملف', languageMode), width: 42 },
    { header: labelForLanguage('Type', 'النوع', languageMode), width: 18 },
    { header: labelForLanguage('Usage', 'الاستخدام', languageMode), width: 24 },
    { header: labelForLanguage('Size KB', 'الحجم فƒيلوبايت', languageMode), width: 12 },
  ];
  contentModel.assets.forEach(asset => {
    assets.addRow([asset.sourceLabel, asset.building, asset.district, asset.name, localizedAssetType(asset.type, languageMode), asset.usage, asset.sizeKB]);
  });
  applyWorksheetDirection(assets, languageMode);

  const outputs = workbook.addWorksheet(safeSheetName(labelForLanguage('Generated Outputs', 'المخرجات الناتجة', languageMode)));
  outputs.columns = [
    { header: labelForLanguage('Label', 'الاسم', languageMode), width: 34 },
    { header: labelForLanguage('Relative Path', 'المسار النسبي', languageMode), width: 60 },
    { header: labelForLanguage('Extension', 'الامتداد', languageMode), width: 14 },
  ];
  deliverables.forEach(file => outputs.addRow([file.label, file.relativePath, file.ext]));
  applyWorksheetDirection(outputs, languageMode);

  const buildings = workbook.addWorksheet(safeSheetName(labelForLanguage('Buildings', 'المباني', languageMode)));
  buildings.columns = [
    { header: labelForLanguage('Building', 'المبنف‰', languageMode), width: 34 },
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
  <text x="${rtlLike ? 1116 : 84}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Indexed project assets', 'أصول المشروع المفف‡رسة', languageMode))}</text>
  <text x="${rtlLike ? 770 : 430}" y="220" text-anchor="${anchor}" font-size="64" font-family="${xmlEscape(font)}" font-weight="700" fill="#38bdf8">${dossier.buildingRecords.length}</text>
  <text x="${rtlLike ? 770 : 430}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Building document groups', 'مجموعات وثائف‚ المباني', languageMode))}</text>
  <text x="${rtlLike ? 420 : 760}" y="220" text-anchor="${anchor}" font-size="64" font-family="${xmlEscape(font)}" font-weight="700" fill="#10b981">${contentModel.counts.html + contentModel.counts.presentations + contentModel.counts.models}</text>
  <text x="${rtlLike ? 420 : 760}" y="250" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#e2e8f0">${xmlEscape(labelForLanguage('Digital and presentation outputs', 'المخرجات الرف‚مية والعرضية', languageMode))}</text>
  ${sourceBlocks}
  <text x="${baseX}" y="740" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="18" font-family="${xmlEscape(font)}" fill="#f8fafc">${xmlEscape(labelForLanguage('Coverage', 'نطاف‚ التغطية', languageMode))}</text>
  <text x="${baseX}" y="772" text-anchor="${anchor}" direction="${rtlLike ? 'rtl' : 'ltr'}" unicode-bidi="plaintext" font-size="15" font-family="${xmlEscape(font)}" fill="#cbd5e1">${xmlEscape(prepareDirectionalText(summaryText, languageMode))}</text>
</svg>`;
}

function buildPortfolioHtml(context, dossier, copiedAssets, outPath) {
  const htmlDir = path.dirname(outPath);
  const lang = context.brand.languageMode;
  const rtlLike = isRtlLanguage(lang);
  const lbl = (en, ar) => labelForLanguage(en, ar, lang);
  const dir = rtlLike ? 'rtl' : 'ltr';
  const fontStack = fontFamilyStack(context.brand.typography, lang);
  const primary = context.brand.primaryColor;
  const accent = context.brand.accentColor;

  const outputRoot = path.resolve(OUTPUTS_DIR);
  const assetUrl = absPath => {
    const resolved = path.resolve(absPath || '');
    if (resolved.startsWith(outputRoot)) {
      return `/outputs/${toWebPath(path.relative(outputRoot, resolved))}`;
    }
    return toWebPath(path.relative(htmlDir, resolved));
  };
  const logoAsset = copiedAssets.find(a => a.usage === 'logo' && a.copiedPath) || null;
  const logoSrc = logoAsset ? assetUrl(logoAsset.copiedPath) : '';

  const webImgs = copiedAssets.filter(a => a.copiedPath && isWebReadyImage(fileExt(a.copiedPath)) && a.usage !== 'logo');
  const models3d = copiedAssets.filter(a => a.copiedPath && a.type === 'model' && ['.glb', '.gltf'].includes(fileExt(a.copiedPath)));

  // â”€â”€ shared CSS + inline three.js minimal GLB viewer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const sharedCss = `
:root{--bg:${primary};--accent:${accent};--card:#0d1b2a;--line:rgba(255,255,255,.11);--text:#f1f5f9;--muted:#94a3b8;--radius:18px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:${fontStack};background:linear-gradient(135deg,${primary} 0%,#060e14 70%);color:var(--text);direction:${dir};text-align:${rtlLike?'right':'left'};min-height:100vh}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:1200px;margin:0 auto;padding:32px 20px 64px}
nav{position:sticky;top:0;z-index:100;background:rgba(6,14,20,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
nav .logo-img{height:40px;object-fit:contain}
nav .site-title{font-weight:700;font-size:15px;flex:1}
nav .nav-links{display:flex;gap:10px;flex-wrap:wrap}
nav .nav-links a{padding:6px 12px;border-radius:999px;font-size:13px;border:1px solid var(--line);transition:background .2s}
nav .nav-links a:hover,nav .nav-links a.active{background:rgba(255,255,255,.08)}
.hero{padding:46px 38px;border:1px solid var(--line);border-radius:28px;background:rgba(255,255,255,.03);backdrop-filter:blur(8px);margin-bottom:28px}
.eyebrow{display:inline-block;padding:7px 14px;border-radius:999px;background:rgba(223,175,103,.13);color:var(--accent);font-weight:700;font-size:12px;letter-spacing:.04em;margin-bottom:14px}
h1{font-size:clamp(26px,5vw,44px);line-height:1.1;margin-bottom:12px}
h2{font-size:22px;margin-bottom:14px;color:var(--text)}
h3{font-size:17px;margin-bottom:8px;color:var(--text)}
p{color:var(--muted);line-height:1.85;margin-bottom:12px}
.metrics-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:22px}
.metric{background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:var(--radius);padding:18px;text-align:center}
.metric strong{display:block;font-size:32px;color:var(--accent);margin-bottom:4px}
.metric span{font-size:13px;color:var(--muted)}
.section-block{background:rgba(13,27,42,.8);border:1px solid var(--line);border-radius:var(--radius);padding:26px;margin-bottom:20px}
.section-heading{font-size:15px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:10px}
.gallery-item{position:relative;border-radius:14px;overflow:hidden;cursor:pointer;border:1px solid var(--line);aspect-ratio:4/3;background:#0a1520}
.gallery-item img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .3s,opacity .3s}
.gallery-item:hover img{transform:scale(1.05);opacity:.85}
.gallery-item figcaption{position:absolute;bottom:0;left:0;right:0;padding:8px 10px;background:rgba(0,0,0,.65);font-size:11.5px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lightbox{display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.92);align-items:center;justify-content:center;flex-direction:column}
.lightbox.open{display:flex}
.lightbox img{max-width:92vw;max-height:82vh;border-radius:12px;object-fit:contain}
.lightbox-caption{color:#cbd5e1;font-size:13px;margin-top:10px;text-align:center}
.lightbox-close{position:absolute;top:18px;right:20px;font-size:28px;cursor:pointer;color:#fff}
.model-viewer{width:100%;height:360px;border:1px solid var(--line);border-radius:var(--radius);background:#060e14;position:relative;overflow:hidden;margin-top:10px}
.model-viewer canvas{display:block;width:100%!important;height:100%!important}
.model-viewer .hint{position:absolute;bottom:10px;left:0;right:0;text-align:center;font-size:11px;color:var(--muted);pointer-events:none}
.building-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:16px}
.building-card{background:rgba(13,27,42,.8);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;transition:transform .25s,box-shadow .25s;display:flex;flex-direction:column}
.building-card:hover{transform:translateY(-4px);box-shadow:0 12px 32px rgba(0,0,0,.4)}
.building-card-thumb{width:100%;height:170px;object-fit:cover;display:block;background:#0a1520}
.building-card-body{padding:16px;flex:1;display:flex;flex-direction:column;gap:6px}
.building-card-body h3{font-size:15px}
.building-card-body p{font-size:13px;flex:1}
.building-card-body a.btn{display:inline-block;margin-top:10px;padding:8px 16px;background:var(--accent);color:#0c1118;border-radius:999px;font-weight:700;font-size:13px;transition:opacity .2s}
.building-card-body a.btn:hover{opacity:.85;text-decoration:none}
.tag{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;background:rgba(255,255,255,.08);color:var(--muted);margin:2px}
.no-content{color:var(--muted);font-size:14px;padding:20px 0;text-align:center}
@media(max-width:600px){.hero{padding:26px 20px}h1{font-size:26px}.gallery-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
`;

  // â”€â”€ Inline minimal three.js GLB viewer script â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Uses three.js r158 from CDN - but we inline the loader call only; the user
  // can open without internet because we reference local .glb files, but three.js
  // itself needs to be included. We embed a tiny fallback canvas message if no JS.
  // For true offline we bundle model-viewer web-component via a data-uri style trick.
  // Practical solution: write three.js + GLTFLoader minimal bundle to portfolio dir.
  const threeScriptPath = path.join(htmlDir, 'three_bundle.js');
  const threeBundle = `
/* Minimal three.js GLB viewer - generated by Service 06 */
(function(){
function initViewer(canvas, modelSrc) {
  if (!window.THREE) { canvas.parentElement.querySelector('.hint').textContent = '3D viewer requires JavaScript'; return; }
  var T = window.THREE;
  var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.01, 1000);
  camera.position.set(0, 1.5, 4);
  scene.add(new T.AmbientLight(0xffffff, 1.2));
  var dir = new T.DirectionalLight(0xffffff, 1.8); dir.position.set(3, 6, 4); scene.add(dir);
  var loader = new T.GLTFLoader ? new T.GLTFLoader() : null;
  if (!loader) { canvas.parentElement.querySelector('.hint').textContent = 'GLTFLoader unavailable'; return; }
  loader.load(modelSrc, function(gltf) {
    var obj = gltf.scene;
    var box = new T.Box3().setFromObject(obj);
    var center = box.getCenter(new T.Vector3());
    var size = box.getSize(new T.Vector3()).length();
    obj.position.sub(center);
    camera.position.set(0, size * 0.3, size * 1.2);
    camera.near = size * 0.001; camera.far = size * 100; camera.updateProjectionMatrix();
    scene.add(obj);
  }, null, function(){ canvas.parentElement.querySelector('.hint').textContent = 'Could not load model'; });
  var isDragging = false, prevX = 0, prevY = 0, rotX = 0, rotY = 0;
  canvas.addEventListener('mousedown', function(e){ isDragging=true; prevX=e.clientX; prevY=e.clientY; });
  canvas.addEventListener('mousemove', function(e){ if(!isDragging) return; rotY+=(e.clientX-prevX)*0.01; rotX+=(e.clientY-prevY)*0.01; prevX=e.clientX; prevY=e.clientY; });
  canvas.addEventListener('mouseup', function(){ isDragging=false; });
  canvas.addEventListener('touchstart', function(e){ prevX=e.touches[0].clientX; prevY=e.touches[0].clientY; },{passive:true});
  canvas.addEventListener('touchmove', function(e){ rotY+=(e.touches[0].clientX-prevX)*0.01; rotX+=(e.touches[0].clientY-prevY)*0.01; prevX=e.touches[0].clientX; prevY=e.touches[0].clientY; },{passive:true});
  function animate(){ requestAnimationFrame(animate); scene.rotation.y=rotY; scene.rotation.x=rotX; renderer.render(scene,camera); }
  animate();
}
window._initGlbViewer = initViewer;
})();
`;
  try { fs.writeFileSync(threeScriptPath, threeBundle); } catch { /* non-fatal */ }

  // â”€â”€ helpers for HTML pages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function rel(absPath) { return xmlEscape(assetUrl(absPath)); }
  function dattr(text) { return htmlDirectionAttrs(text, lang); }
  function dt(text) { return xmlEscape(prepareDirectionalText(text, lang)); }

  function gallerySection(titleEn, titleAr, assets, idPrefix) {
    if (!assets.length) return '';
    const items = assets.map((a, i) => {
      const src = rel(a.copiedPath);
      const cap = a.name || '';
      return `<figure class="gallery-item" onclick="openLb('${idPrefix}',${i})">
  <img src="${src}" alt="${xmlEscape(cap)}" loading="lazy">
  <figcaption ${dattr(cap)}>${dt(cap)}</figcaption>
</figure>`;
    }).join('\n');
    const lbImgs = assets.map(a =>
      `<img src="${rel(a.copiedPath)}" alt="${xmlEscape(a.name||'')}" loading="lazy">`,
    ).join('\n');
    return `
<div class="section-block">
  <div class="section-heading" ${dattr(lbl(titleEn,titleAr))}>${dt(lbl(titleEn,titleAr))}</div>
  <div class="gallery-grid">${items}</div>
</div>
<div class="lightbox" id="lb_${idPrefix}" onclick="closeLb('${idPrefix}')">
  <span class="lightbox-close" onclick="closeLb('${idPrefix}')">&times;</span>
  <div id="lb_${idPrefix}_imgs" style="display:contents">${lbImgs}</div>
  <div class="lightbox-caption" id="lb_${idPrefix}_cap"></div>
</div>`;
  }

  function modelViewerBlock(modelsArr) {
    if (!modelsArr.length) return '';
    const tabs = modelsArr.map((m, i) => {
      const src = rel(m.copiedPath);
      const mid = `mdl_${i}_${Math.random().toString(36).slice(2,7)}`;
      return `
<div class="section-block" style="margin-bottom:14px">
  <div class="section-heading" ${dattr(m.name)}>${dt(m.name)}</div>
  <div class="model-viewer">
    <canvas id="${mid}" style="width:100%;height:100%"></canvas>
    <div class="hint">${'Drag to rotate 3D model'}</div>
  </div>
  <script>window.addEventListener('load',function(){if(window._initGlbViewer){var c=document.getElementById('${mid}');window._initGlbViewer(c,'${src}');}});<\/script>
</div>`;
    }).join('\n');
    return tabs;
  }

  function navHtml(activePage = 'index') {
    const buildingLinks = dossier.buildingRecords.map((b, i) => {
      const slug = `building_${i + 1}.html`;
      const isActive = activePage === slug ? ' class="active"' : '';
      return `<a href="${slug}"${isActive} title="${xmlEscape(b.name)}">${dt(b.name.split(/[\s,،]/)[0])}</a>`;
    }).join('');
    return `<nav>
  ${logoSrc ? `<img class="logo-img" src="${xmlEscape(logoSrc)}" alt="logo">` : ''}
  <span class="site-title" ${dattr(context.brand.projectName)}>${dt(context.brand.projectName)}</span>
  <div class="nav-links">
    <a href="index.html"${activePage === 'index' ? ' class="active"' : ''}>${dt('Home')}</a>
    ${buildingLinks}
  </div>
</nav>`;
  }

  function pageShell(titleText, bodyContent, activePage = 'index') {
    return `<!DOCTYPE html>
<html lang="${rtlLike ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlEscape(titleText)} — ${xmlEscape(context.brand.projectName)}</title>
<style>${sharedCss}</style>
<script>
function openLb(id,idx){
  var lb=document.getElementById('lb_'+id);
  var imgs=lb.querySelectorAll('img');
  imgs.forEach(function(img,i){img.style.display=i===idx?'block':'none';});
  var caps=lb.querySelectorAll('figcaption');
  document.getElementById('lb_'+id+'_cap').textContent=imgs[idx]?imgs[idx].alt:'';
  lb.classList.add('open');
  document.body.style.overflow='hidden';
}
function closeLb(id){
  document.getElementById('lb_'+id).classList.remove('open');
  document.body.style.overflow='';
}
document.addEventListener('keydown',function(e){if(e.key==='Escape'){document.querySelectorAll('.lightbox.open').forEach(function(lb){lb.classList.remove('open');document.body.style.overflow='';});}});
<\/script>
<script src="three_bundle.js"><\/script>
</head>
<body>
${navHtml(activePage)}
<div class="wrap">${bodyContent}</div>
</body>
</html>`;
  }

  // â”€â”€ INDEX PAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const allGalleryImgs = webImgs.slice(0, 12);
  const allGalleryHtml = gallerySection('Visual Gallery', 'معرض بصري', allGalleryImgs, 'idx_gallery');
  const allModels = models3d.slice(0, 4);
  const allModelsHtml = modelViewerBlock(allModels);

  const buildingCardsHtml = dossier.buildingRecords.map((b, i) => {
    const slug = `building_${i + 1}.html`;
    const thumbImg = copiedAssets.find(a =>
      a.copiedPath && isWebReadyImage(fileExt(a.copiedPath)) && a.usage !== 'logo' &&
      normalizeText(a.building) === b.name,
    ) || webImgs[i % Math.max(webImgs.length, 1)];
    const thumbSrc = thumbImg ? rel(thumbImg.copiedPath) : '';
    return `<div class="building-card">
  ${thumbSrc ? `<img class="building-card-thumb" src="${thumbSrc}" alt="${xmlEscape(b.name)}" loading="lazy">` : '<div class="building-card-thumb"></div>'}
  <div class="building-card-body">
    <h3 ${dattr(b.name)}>${dt(b.name)}</h3>
    <p ${dattr(b.summary)}>${dt(b.summary.slice(0, 120))}${b.summary.length > 120 ? '...' : ''}</p>
    <a class="btn" href="${slug}">${dt(lbl('View Details','عرض التفاصيل'))}</a>
  </div>
</div>`;
  }).join('\n');

  const indexBody = `
<section class="hero">
  ${logoSrc ? `<div style="text-align:center;margin-bottom:16px"><img src="${xmlEscape(logoSrc)}" style="max-height:72px;object-fit:contain" alt="logo"></div>` : ''}
  <span class="eyebrow">${dt(lbl('Digital Portfolio','المحفظة الرف‚مية'))}</span>
  <h1 ${dattr(context.brand.projectName)}>${dt(context.brand.projectName)}</h1>
  ${splitNarrativeParagraphs(dossier.executiveSummary).map(p => `<p ${dattr(p)}>${dt(p)}</p>`).join('')}
  <div class="metrics-row">
    <div class="metric"><strong>${copiedAssets.length}</strong><span>${dt(lbl('Total files','إجمالي الملفات'))}</span></div>
    <div class="metric"><strong>${dossier.buildingRecords.length}</strong><span>${dt(lbl('Buildings','المباني'))}</span></div>
    <div class="metric"><strong>${webImgs.length}</strong><span>${dt(lbl('Images','صور'))}</span></div>
    <div class="metric"><strong>${models3d.length}</strong><span>${dt(lbl('3D Models','نماذج ثلاثية الأبعاد'))}</span></div>
  </div>
</section>

<div class="section-block">
  <div class="section-heading">${dt(lbl('Building Documentation','توثيف‚ المباني'))}</div>
  <div class="building-cards">${buildingCardsHtml || `<p class="no-content">${dt(lbl('No buildings found.','لم تُعثر علف‰ مباني.'))}</p>`}</div>
</div>

${allGalleryHtml}
${allModelsHtml}
`;

  fs.writeFileSync(outPath, pageShell(lbl('Home', 'الرئيسية'), indexBody, 'index'));

  // â”€â”€ PER-BUILDING PAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  dossier.buildingRecords.forEach((building, bIdx) => {
    const slug = `building_${bIdx + 1}.html`;
    const outBldg = path.join(htmlDir, slug);
    const bAssets = building.assets.filter(a => a.copiedPath);

    const bWebImgs = bAssets.filter(a => isWebReadyImage(fileExt(a.copiedPath)) && a.copiedPath);
    const bModels = bAssets.filter(a => ['.glb', '.gltf'].includes(fileExt(a.copiedPath)));
    const imgBySvc = svc => bWebImgs.filter(a => a.service === svc);

    const beforeAfterSection = gallerySection('Before / After Photos', 'صور ف‚بل / بعد', imgBySvc(1).slice(0, 8), `b${bIdx}_ba`);
    const drawingImgs = bWebImgs.filter(a => a.service === 2 && (a.type === 'drawing' || a.usage === 'technical-drawing')).slice(0, 8);
    const drawingsSection = gallerySection('Architectural Drawings', 'المخططات المعمارية (مساف‚طي واجف‡اتي مف‚اطع)', drawingImgs, `b${bIdx}_drw`);
    const vizImgs = [...imgBySvc(2), ...imgBySvc(5)].slice(0, 10);
    const vizSection = gallerySection('2D & 3D Visualizations', 'التصورات ثنائية وثلاثية الأبعاد', vizImgs, `b${bIdx}_viz`);
    const histImgs = imgBySvc(4).slice(0, 6);
    const histSection = gallerySection('Historical Photos', 'الصور التاريخية', histImgs, `b${bIdx}_hist`);
    const allBuildingImgsSection = !beforeAfterSection && !drawingsSection && !vizSection && !histSection
      ? gallerySection('Available Images', 'الصور المتاحة', bWebImgs.slice(0, 12), `b${bIdx}_all`)
      : '';

    const s4Job = context.linkedJobs?.find(j => j.service === 4) || null;
    const histText = s4Job?.metadata?.project?.description || s4Job?.metadata?.summary
      || lbl('Historical documentation was prepared as part of the academic reporting phase.', 'أُعد التوثيف‚ التاريخي ضمن مرحلة إعداد التف‚ارير الأفƒاديمية.');

    const otherFiles = bAssets.filter(a => !isWebReadyImage(fileExt(a.copiedPath)) && !(['.glb', '.gltf'].includes(fileExt(a.copiedPath)))).slice(0, 20);
    const fileListHtml = otherFiles.length
      ? `<div class="section-block">
  <div class="section-heading">${dt(lbl('Linked Documents & Files', 'الملفات والوثائف‚ المرتبطة'))}</div>
  <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">${otherFiles.map(a => `<a href="${rel(a.copiedPath)}" target="_blank" class="tag">- ${xmlEscape(a.name)}</a>`).join('')}</div>
</div>` : '';

    const bHeroImg = bWebImgs[0];
    const bldgBody = `
<section class="hero">
  ${bHeroImg ? `<img src="${rel(bHeroImg.copiedPath)}" alt="${xmlEscape(building.name)}" style="width:100%;max-height:340px;object-fit:cover;border-radius:16px;margin-bottom:22px">` : ''}
  <span class="eyebrow">${dt(lbl('Building Documentation','توثيف‚ المبنف‰'))}</span>
  <h1 ${dattr(building.name)}>${dt(building.name)}</h1>
  <p ${dattr(context.brand.projectName)} style="font-size:14px;color:var(--accent)">${dt(context.brand.projectName)}</p>
  <div class="metrics-row" style="margin-top:14px">
    <div class="metric"><strong>${bAssets.length}</strong><span>${dt(lbl('Total assets','إجمالي الأصول'))}</span></div>
    <div class="metric"><strong>${bWebImgs.length}</strong><span>${dt(lbl('Images','صور'))}</span></div>
    <div class="metric"><strong>${bModels.length}</strong><span>${dt(lbl('3D Models','نماذج ثلاثية الأبعاد'))}</span></div>
  </div>
</section>

<div class="section-block">
  <div class="section-heading">${dt(lbl('Architectural Description', 'الوصف المعماري الفƒامل'))}</div>
  ${splitNarrativeParagraphs(building.summary).map(p => `<p ${dattr(p)}>${dt(p)}</p>`).join('')}
</div>

${beforeAfterSection}
${drawingsSection}
${vizSection}

<div class="section-block">
  <div class="section-heading">${dt(lbl('Historical Analysis', 'التحليل التاريخي'))}</div>
  <p ${dattr(histText)}>${dt(histText)}</p>
</div>
${histSection}
${allBuildingImgsSection}

${bModels.length ? `<div class="section-block">
  <div class="section-heading">${dt(lbl('3D Model Viewer','عارض النماذج ثلاثية الأبعاد'))}</div>
  <p ${dattr(lbl('Drag and pinch to rotate and zoom the model.','اسحب وف‚رف‘ب/بعف‘د لتدوير النموذج وتفƒبيرف‡.'))} style="margin-bottom:12px">${dt(lbl('Drag and pinch to rotate and zoom.','اسحب وف‚رف‘ب/بعف‘د للتحفƒم في العرض.'))}</p>
  ${modelViewerBlock(bModels.slice(0, 3))}
</div>` : ''}

${fileListHtml}

<div style="margin-top:24px">
  <a href="index.html" style="color:var(--muted);font-size:14px">&larr; ${dt(lbl('Back to project home','العودة إلف‰ الصفحة الرئيسية'))}</a>
</div>`;

    fs.writeFileSync(outBldg, pageShell(building.name, bldgBody, slug));
  });
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
    context.linkedJobs = dedupedJobs;

    const baseDossier = buildDossierModel(context, dedupedJobs, contentModel);
    const narrativeSynthesis = await synthesizeDossierNarrative(context, dedupedJobs, contentModel, baseDossier);
    const dossier = applyNarrativeBundleToDossier(baseDossier, narrativeSynthesis.narrative);

    const packageRootName = `RUAA_Project_${slugify(context.brand.projectName, 'project')}`;
    const packageRoot = path.join(jobDir, packageRootName);
    ensureDir(packageRoot);

    const copiedAssets = copyAssetsIntoPackage(packageRoot, contentModel, context.brand);
    context.brand.logoPath = firstLogoFromAssets(copiedAssets)?.copiedPath || null;
    const presentationPptDir = path.join(packageRoot, '05_Presentations', 'PPT');
    const presentationBoardsDir = path.join(packageRoot, '05_Presentations', 'Boards');
    const projectBoardsDir = path.join(presentationBoardsDir, 'Project');
    const buildingBoardsDir = path.join(presentationBoardsDir, 'Buildings');
    const dossierPdfDir = path.join(packageRoot, '06_Dossier', 'Complete_Dossier_PDF');
    const dossierWordDir = path.join(packageRoot, '06_Dossier', 'Complete_Dossier_Word');
    const buildingDir = path.join(packageRoot, '06_Dossier', 'Individual_Buildings');
    const portfolioDir = path.join(packageRoot, '07_Digital_Portfolio', 'HTML_Website');
    const mediaDir = path.join(packageRoot, '08_Media', 'Infographics');
    const videoDir = path.join(packageRoot, '08_Media', 'Videos');
    const reportsDir = path.join(packageRoot, '04_Reports', 'Data_Excel');
    [presentationPptDir, projectBoardsDir, buildingBoardsDir, dossierPdfDir, dossierWordDir, buildingDir, portfolioDir, mediaDir, videoDir, reportsDir].forEach(ensureDir);

    const dossierPdfPath = path.join(dossierPdfDir, 'main_project_dossier.pdf');
    const dossierWordPath = path.join(dossierWordDir, 'main_project_dossier.docx');
    const projectPptPath = path.join(presentationPptDir, 'project_summary.pptx');
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
    const presentationOptions = {
      enableNanoBanana: parseBooleanLike(req.body.enableNanoBanana, true),
      boardPromptOverride: normalizeText(req.body.boardPromptOverride || ''),
      coverage: dossier.coverage || buildCoverageModel(dedupedJobs, contentModel),
      totalAssets: contentModel.counts.totalAssets,
      buildingCount: dossier.buildingRecords.length,
    };
    const selectedExports = normalizeExportPreferences(context.project.exportPreferences);
    const wantsPdf = selectedExports.has('pdf');
    const wantsWord = selectedExports.has('word');
    const wantsPptx = selectedExports.has('pptx');
    const wantsHtml = selectedExports.has('html');
    const wantsXlsx = selectedExports.has('xlsx');
    const wantsZip = selectedExports.has('zip');
    const rawGeneratedDeliverables = [];
    const trackGeneratedDeliverable = (label, filePath, extOverride = null) => {
      if (!filePath || !fs.existsSync(filePath)) return;
      const ext = extOverride || fileExt(filePath).slice(1) || 'txt';
      let safeLabel = label;
      if (/[ÃÙØ]/.test(safeLabel)) {
        const family = getDeliverableExportFamily({ label: safeLabel, ext });
        const fallbackByFamily = {
          pdf: 'PDF',
          word: 'Word',
          pptx: 'PPTX',
          html: 'HTML',
          xlsx: 'Excel',
          zip: 'ZIP',
        };
        const fallback = fallbackByFamily[family];
        if (fallback) safeLabel = safeLabel.replace(/\([^)]*\)$/, `(${fallback})`);
      }
      rawGeneratedDeliverables.push({
        label: safeLabel,
        path: filePath,
        ext,
        relativePath: toWebPath(path.relative(packageRoot, filePath)),
      });
    };

    if (wantsWord) {
      await buildWordDossier(dossier, context, dossierWordPath);
      trackGeneratedDeliverable('Main Dossier (Word)', dossierWordPath);
    }
    if (wantsPdf) {
      await buildPdfDossier(dossier, context, representativeImages, dossierPdfPath);
      trackGeneratedDeliverable('Main Dossier (PDF)', dossierPdfPath);
    }

    for (const building of dossier.buildingRecords) {
      const slug = slugify(building.name, 'building');
      const buildingWordPath = path.join(buildingDir, `${slug}.docx`);
      const buildingPdfPath = path.join(buildingDir, `${slug}.pdf`);
      const buildingPptSubdir = path.join(presentationPptDir, 'Buildings');
      const buildingPptPath = path.join(buildingPptSubdir, `${slug}.pptx`);
      const buildingBoardDir = path.join(buildingBoardsDir, slug);
      const imagePath = firstImageFromAssets(copiedAssets.filter(asset => asset.building === building.name));
      if (wantsWord) {
        await buildWordBuildingDocument(building, context, buildingWordPath);
        trackGeneratedDeliverable(`${building.name} (${labelForLanguage('Word', 'ÙˆÙˆØ±Ø¯', context.brand.languageMode)})`, buildingWordPath);
      }
      if (wantsPdf) {
        await buildPdfBuildingDocument(building, context, imagePath, buildingPdfPath);
        trackGeneratedDeliverable(`${building.name} (${labelForLanguage('PDF', 'Ø¨ÙŠ Ø¯ÙŠ Ø¥Ù', context.brand.languageMode)})`, buildingPdfPath);
      }
      if (wantsPptx) {
        ensureDir(buildingPptSubdir);
        ensureDir(buildingBoardDir);
        await buildArchitecturalPresentationPackage({
          name: building.name,
          summary: building.summary,
        }, context, building.assets, buildingPptPath, buildingBoardDir, presentationOptions);
        trackGeneratedDeliverable(`${building.name} (${labelForLanguage('PPTX', 'ÙˆÙˆØ±Ø¯', context.brand.languageMode)})`, buildingPptPath);
      }

      /* buildingOutputs.push(
        { label: `${building.name} (${labelForLanguage('Word', 'وورد', context.brand.languageMode)})`, path: buildingWordPath },
        { label: `${building.name} (${labelForLanguage('PDF', 'بي دي إف', context.brand.languageMode)})`, path: buildingPdfPath },
        { label: `${building.name} (${labelForLanguage('PPTX', 'بوربوينت', context.brand.languageMode)})`, path: buildingPptPath },
      ); */
    }

    let projectPresentation = null;
    if (wantsPptx) projectPresentation = await buildArchitecturalPresentationPackage({
      name: context.brand.projectName,
      summary: dossier.executiveSummary,
    }, context, copiedAssets.filter(asset => asset.usage !== 'logo'), projectPptPath, projectBoardsDir, presentationOptions);
    if (wantsPptx) {
      trackGeneratedDeliverable('Project Summary (PPTX)', projectPptPath);
      if (projectPresentation?.boardImages?.[0]) trackGeneratedDeliverable('Project Cover Board (PNG)', projectPresentation.boardImages[0]);
      if (projectPresentation?.boardImages?.[6]) trackGeneratedDeliverable('Project Board Preview (PNG)', projectPresentation.boardImages[6]);
    }

    if (wantsPdf) {
      const infographicPaths = await buildInfographics(context, contentModel, dossier, mediaDir, { formats: ['pdf'] });
      if (infographicPaths?.pdfPath) trackGeneratedDeliverable('Infographic (PDF)', infographicPaths.pdfPath);
    }
    /* fs.writeFileSync(promoScriptPath, buildPromoScript(context, dossier, contentModel, narrativeSynthesis.narrative));
    fs.writeFileSync(captionsPath, buildSocialCaptions(context, contentModel, narrativeSynthesis.narrative));
    fs.writeFileSync(userGuidePath, [
      localizeTemplateText(`${context.brand.projectName} - User Guide`, `${context.brand.projectName} - دليل الاستخدام`, context.brand.languageMode),
      '',
      localizeTemplateText('1. Open the PDF dossier for official review or printing.', '1. افتح ملف PDF الخاص بالوثيف‚ة الشاملة للمراجعة الرسمية أو الطباعة.', context.brand.languageMode),
      localizeTemplateText('2. Open the DOCX dossier when editable narrative formatting is required.', '2. افتح ملف DOCX عندما تفƒون ف‡نافƒ حاجة إلف‰ تعديل السرد أو التنسيف‚.', context.brand.languageMode),
      localizeTemplateText('3. Use the PPTX deck and the board sheets inside 05_Presentations for presentation and stakeholder briefing.', '3. استخدم ملف PPTX ولوحات العرض داخل 05_Presentations للعروض التف‚ديمية وإحاطة أصحاب المصلحة.', context.brand.languageMode),
      localizeTemplateText('4. Open 07_Digital_Portfolio/HTML_Website/index.html for the portfolio microsite.', '4. افتح 07_Digital_Portfolio/HTML_Website/index.html لعرض موف‚ع المحفظة الرف‚مية.', context.brand.languageMode),
      localizeTemplateText('5. Review 04_Reports/Data_Excel/generated_outputs.xlsx for the full output inventory.', '5. راجع 04_Reports/Data_Excel/generated_outputs.xlsx للاطلاع علف‰ ف‚ائمة المخرجات فƒاملة.', context.brand.languageMode),
      localizeTemplateText('6. Review 08_Media/Videos for script-ready promotional content.', '6. راجع 08_Media/Videos للوصول إلف‰ المحتوف‰ الإعلامي الجاف‡ز للنصوص.', context.brand.languageMode),
    ].join('\n')); */

    if (wantsHtml) {
      buildPortfolioHtml(context, dossier, copiedAssets, portfolioHtmlPath);
      trackGeneratedDeliverable('Digital Portfolio (HTML)', portfolioHtmlPath);
    }

    const generatedDeliverables = rawGeneratedDeliverables.slice();

    if (wantsXlsx) {
      await buildExcelManifest(context, dossier, contentModel, generatedDeliverables, outputManifestPath);
      generatedDeliverables.push({
      label: localizeTemplateText('Generated Outputs Manifest (Excel)', 'فف‡رس المخرجات الناتجة (Excel)', context.brand.languageMode),
      path: outputManifestPath,
      ext: 'xlsx',
      relativePath: toWebPath(path.relative(packageRoot, outputManifestPath)),
    });
    }

    const metadata = {
      jobId,
      service: 6,
      serviceName: SERVICE_06_NAME,
      serviceDefinition: SERVICE_06_DEFINITION,
      project: context.project,
      brand: context.brand,
      textGeneration: {
        aiModel: context.ai.modelLabel,
        aiModelKey: context.ai.model,
        provider: narrativeSynthesis.provider,
        model: narrativeSynthesis.model,
      },
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
      presentationPackage: {
        boardMode: true,
        nanoBananaEnabled: presentationOptions.enableNanoBanana,
        projectDeck: {
          slideCount: projectPresentation?.slideCount || 0,
          boardCount: projectPresentation?.boardImages?.length || 0,
          provider: projectPresentation?.provider || 'local-board-layout',
          model: projectPresentation?.model || 'local-architectural-board-composer-v1',
        },
      },
      generatedAt: new Date().toISOString(),
      warnings: [
        ...narrativeSynthesis.warnings,
        neutralizeServiceMentions('This package fully handles local aggregation, indexing, folder packaging, PDF/Word/PPTX/HTML generation, architecture-board composition, infographics, and script-ready media support.', context.brand.languageMode),
        neutralizeServiceMentions('Rendered MP4 video generation, studio-grade voiceover synthesis, and advanced live 3D/map embedding beyond linked HTML assets would require additional runtime tooling or external APIs.', context.brand.languageMode),
        ...(projectPresentation?.provider === 'local-board-layout'
          ? [neutralizeServiceMentions('Nano Banana 2 refinement was not applied during generation, so Service 06 used the local architectural board composer fallback for presentation boards.', context.brand.languageMode)]
          : []),
      ],
    };

    fs.writeFileSync(metadataSummaryPath, JSON.stringify(metadata, null, 2));
    const packageSupportFiles = [];
    packageSupportFiles.push({
      label: localizeTemplateText('Package Manifest (JSON)', 'بيانات الحزمة (JSON)', context.brand.languageMode),
      path: metadataSummaryPath,
      ext: 'json',
      relativePath: toWebPath(path.relative(packageRoot, metadataSummaryPath)),
    });

    fs.writeFileSync(readmePath, buildReadmeText(context, dossier, [...generatedDeliverables, ...packageSupportFiles], packageRootName));
    packageSupportFiles.push({
      label: localizeTemplateText('README', 'دليل الحزمة', context.brand.languageMode),
      path: readmePath,
      ext: 'txt',
      relativePath: toWebPath(path.relative(packageRoot, readmePath)),
    });

    const excludedZipPaths = new Set(
      rawGeneratedDeliverables
        .filter(file => !isDeliverableSelected(file, selectedExports))
        .map(file => path.resolve(file.path)),
    );
    const outputFiles = generatedDeliverables.map(file => ({
      label: file.label,
      url: relOutputUrl(jobId, file.path),
      ext: file.ext,
    }));

    if (wantsZip) {
      const zipEntries = collectZipEntries(packageRoot, packageRoot, [], excludedZipPaths);
      fs.writeFileSync(bundleZipPath, createStoredZip(zipEntries));
      outputFiles.push({
        label: localizeTemplateText('Delivery Bundle (ZIP)', 'حزمة التسليم (ZIP)', context.brand.languageMode),
        url: relOutputUrl(jobId, bundleZipPath),
        ext: 'zip',
      });
    }

    const metaPath = path.join(jobDir, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, outputFiles }, null, 2));
    outputFiles.push({
      label: localizeTemplateText('Service 06 Metadata (JSON)', 'بيانات الخدمة 06 (JSON)', context.brand.languageMode),
      url: relOutputUrl(jobId, metaPath),
      ext: 'json',
    });

    const publicOutputFiles = outputFiles.filter(file => {
      const family = getDeliverableExportFamily(file);
      return family ? selectedExports.has(family) : false;
    });
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, outputFiles: publicOutputFiles }, null, 2));

    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'done';
        jobRecord.outputFiles = publicOutputFiles;
        jobRecord.completedAt = new Date();
        jobRecord.metadata = { ...metadata, outputFiles: publicOutputFiles };
        await jobRecord.save();
      } catch (error) {
        // Ignore optional persistence failures.
      }
    }

    res.json({
      success: true,
      jobId,
      serviceName: SERVICE_06_NAME,
      provider: narrativeSynthesis.provider || 'local-packaging',
      model: narrativeSynthesis.model || 'documentation-media-pipeline-v1',
      preview: buildResponsePreview(context, dossier, contentModel, publicOutputFiles),
      outputFiles: publicOutputFiles,
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



