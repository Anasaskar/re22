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

function buildContentModel(project, linkedJobs, uploadedFilesSummary) {
  const assets = [];

  for (const job of linkedJobs) {
    for (const file of job.files) {
      assets.push({
        id: `${job.jobId}:${file.name}`,
        sourceKind: 'linked-job',
        service: job.service,
        serviceName: job.serviceName,
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

  const byService = assets.reduce((acc, asset) => {
    const label = asset.serviceName || 'Unknown';
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return {
    assets,
    byBuilding: grouped('building'),
    byDistrict: grouped('district'),
    byType,
    byService,
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
    project,
    brand: buildBrandProfile(input, uploadedFilesSummary),
  };
}

function buildBuildingRecords(contentModel, linkedJobs, brand) {
  const entries = Object.entries(contentModel.byBuilding)
    .filter(([name]) => normalizeText(name) && name !== 'Project-wide');

  if (!entries.length) {
    return [{
      name: normalizeText(brand.projectName, 'General Building File'),
      assets: contentModel.assets.slice(0, 24),
      summary: 'No building-specific names were provided, so a general building documentation file will be generated from the full project package.',
    }];
  }

  return entries.map(([name, assets]) => {
    const relatedServices = [...new Set(assets.map(asset => asset.serviceName).filter(Boolean))];
    return {
      name,
      assets,
      summary: `${name} consolidates ${assets.length} files from ${relatedServices.join(', ') || 'project sources'}.`,
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
  const serviceList = [...new Set(linkedJobs.map(job => `${job.serviceName} (Service ${job.service})`))];
  const typeSummary = Object.entries(contentModel.byType)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');

  const sections = [
    {
      id: 'front_matter',
      title: labelForLanguage('Front Matter', 'التمهيد', languageMode),
      body: `${context.brand.projectName} was prepared for ${context.brand.implementingBody}. Date of preparation: ${context.brand.preparationDate}. Consultant / researcher team: ${context.brand.consultantTeam}.`,
    },
    {
      id: 'project_overview',
      title: labelForLanguage('Project Overview', 'نظرة عامة على المشروع', languageMode),
      body: `${context.brand.projectName} aggregates ${contentModel.counts.totalAssets} deliverable files from ${totalJobs} linked job(s) across ${serviceList.join(', ')}. The package is organized for documentation, presentation, publication, review, and digital delivery.`,
    },
    {
      id: 'historical_context',
      title: labelForLanguage('Historical and Geographic Context', 'السياق التاريخي والجغرافي', languageMode),
      body: service3
        ? `${normalizeText(service3.metadata?.districtName, 'The project area')} in ${normalizeText(service3.metadata?.city, context.project.projectLocation || 'the referenced location')} is represented through district-scale urban analysis, terrain-aware mapping, and heritage-fabric interpretation.`
        : `Historical and geographic context should be read alongside the linked reports and maps packaged in this delivery. The current implementation preserves and indexes the available source materials even when structured narrative metadata is limited.`,
    },
    {
      id: 'building_chapters',
      title: labelForLanguage('Building Chapters', 'فصول المباني', languageMode),
      body: `Building-level documentation has been generated for ${buildingRecords.length} building group(s). Each document consolidates before/after visuals where available, linked drawings, analytical references, 3D views, and implementation notes.`,
    },
    {
      id: 'urban_analysis',
      title: labelForLanguage('Urban Fabric Analysis', 'تحليل النسيج العمراني', languageMode),
      body: service3
        ? `Urban outputs include district plans, geospatial datasets, analytical maps, and interactive portfolio material. District-scale coverage includes ${compactText(JSON.stringify(service3.metadata?.districtSummary || {}), 220)}.`
        : `Urban analysis assets were not explicitly linked, but the dossier structure reserves a dedicated section so district-scale materials can be integrated consistently when present.`,
    },
    {
      id: 'standards_compliance',
      title: labelForLanguage('Standards and Compliance Analysis', 'تحليل المعايير والامتثال', languageMode),
      body: service4
        ? `Academic and standards-oriented outputs from Service 04 are integrated as supporting evidence for references, methodology, and compliance-oriented communication.`
        : `This package provides placeholders and structured appendices for standards and compliance analysis; richer narrative interpretation can be layered from Service 04 reports or external policy review when required.`,
    },
    {
      id: 'implementation_plan',
      title: labelForLanguage('Implementation Plan', 'خطة التنفيذ', languageMode),
      body: `The delivery package separates source imagery, technical drawings, 3D models, reports, presentations, dossier outputs, digital portfolio files, and media assets into a controlled handover structure. This supports phased review, printing, presentation, and downstream refinement.`,
    },
    {
      id: 'conclusion',
      title: labelForLanguage('Conclusion', 'الخاتمة', languageMode),
      body: `This Service 06 package transforms technical project outputs into a communication-ready documentation set with clear branding, delivery indexing, reusable building templates, and digital-ready presentation outputs. Current file-type coverage: ${typeSummary}.`,
    },
  ];

  const references = [
    ...linkedJobs.map(job => ({
      title: `${job.serviceName} metadata package`,
      note: `${job.title} (${job.jobId})`,
    })),
  ];

  if (service5) {
    references.push({
      title: 'Procedural 3D deliverables',
      note: 'Interactive viewer and render outputs were incorporated into the media and digital portfolio layers.',
    });
  }

  return {
    title: labelForLanguage('Comprehensive Project Dossier', 'الوثيقة التوثيقية الشاملة للمشروع', languageMode),
    subtitle: context.brand.projectName,
    executiveSummary: `${context.brand.projectName} consolidates ${contentModel.counts.totalAssets} indexed assets into a professional communication package that includes a comprehensive dossier, building-level documents, media-ready outputs, a digital portfolio, and delivery manifests.`,
    methodology: `The Service 06 pipeline collects linked jobs from Services 01 to 05, classifies files by building, district, type, and usage, applies the selected project identity, and generates structured exports for print, presentation, and digital delivery.`,
    buildingRecords,
    sections,
    references,
    appendices: [
      'Asset register and output manifest',
      'Packaging manifest and delivery README',
      'Building document list',
      'Digital portfolio index',
      'Media script and captions pack',
    ],
  };
}

function buildReadmeText(context, dossier, outputFiles, packageRootName) {
  const lines = [
    `${context.brand.projectName}`,
    `${SERVICE_06_NAME}`,
    '',
    `Package root: ${packageRootName}`,
    `Preparation date: ${context.brand.preparationDate}`,
    `Implementing body: ${context.brand.implementingBody}`,
    `Consultant / researcher team: ${context.brand.consultantTeam}`,
    `Language mode: ${context.brand.languageMode}`,
    '',
    'Included deliverables:',
    ...outputFiles.map(file => `- ${file.label}: ${file.relativePath}`),
    '',
    'Folder notes:',
    '- 01_Images: restored images, visualizations, and render-derived stills',
    '- 02_Plans: floor plans, urban plans, vector drawings, and printable sheets',
    '- 03_3D_Models: print-ready and viewing-ready model exports',
    '- 04_Reports: narrative reports, spreadsheets, metadata, and documentation tables',
    '- 05_Presentations: presentation decks and slide-ready summaries',
    '- 06_Dossier: comprehensive dossier and building-level documentation',
    '- 07_Digital_Portfolio: standalone HTML delivery and portfolio assets',
    '- 08_Media: infographic and promotional media support files',
    '',
    'Usage guidance:',
    '- Open PDF files for print-ready review.',
    '- Edit DOCX files when narrative customization is needed.',
    '- Open PPTX files for decision-maker presentations.',
    '- Open 07_Digital_Portfolio/HTML_Website/index.html in a browser for the portfolio view.',
    '- Use the Excel manifest to review specifications and generated outputs.',
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

async function buildWordDossier(dossier, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

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
    new Paragraph({ text: `${labelForLanguage('Consultant Team', 'الفريق الاستشاري', context.brand.languageMode)}: ${context.brand.consultantTeam}` }),
    new Paragraph({ text: `${labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: dossier.executiveSummary }),
    new Paragraph({ text: `${labelForLanguage('Methodology', 'المنهجية', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: dossier.methodology }),
    new Paragraph({ text: `${labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode)}`, heading: HeadingLevel.HEADING_1 }),
  ];

  dossier.sections.forEach((section, index) => {
    children.push(new Paragraph({ text: `${index + 1}. ${section.title}` }));
  });

  dossier.sections.forEach(section => {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: section.body }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode), heading: HeadingLevel.HEADING_1 }));
  dossier.buildingRecords.forEach((building, index) => {
    children.push(new Paragraph({ text: `${index + 1}. ${building.name}`, heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: building.summary }));
  });

  children.push(new Paragraph({ text: labelForLanguage('References', 'المراجع', context.brand.languageMode), heading: HeadingLevel.HEADING_1 }));
  dossier.references.forEach(ref => {
    children.push(new Paragraph({ text: `${ref.title} - ${ref.note}` }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Appendices', 'الملاحق', context.brand.languageMode), heading: HeadingLevel.HEADING_1 }));
  dossier.appendices.forEach(item => {
    children.push(new Paragraph({ text: item }));
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

    if (doc.outline && doc.outline.addItem) {
      doc.outline.addItem(dossier.title);
    }

    setPdfFont(doc, true).fontSize(24).fillColor(context.brand.primaryColor).text(dossier.title, { align: 'center' });
    doc.moveDown(0.3);
    setPdfFont(doc, false).fontSize(14).fillColor('#334155').text(dossier.subtitle, { align: 'center' });
    doc.moveDown(0.2);
    setPdfFont(doc, false).fontSize(10).fillColor('#475569').text(`${context.brand.implementingBody} | ${context.brand.preparationDate}`, { align: 'center' });
    doc.moveDown(1);

    if (images[0] && fs.existsSync(images[0].path)) {
      try {
        doc.image(images[0].path, { fit: [515, 220], align: 'center' });
        doc.moveDown(0.8);
      } catch (error) {
        // Ignore broken images and continue.
      }
    }

    setPdfFont(doc, true).fontSize(14).fillColor('#0f172a').text(labelForLanguage('Executive Summary', 'الملخص التنفيذي', context.brand.languageMode));
    doc.moveDown(0.2);
    setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(dossier.executiveSummary, { align: 'justify' });
    doc.moveDown(0.7);

    setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(labelForLanguage('Table of Contents', 'جدول المحتويات', context.brand.languageMode));
    dossier.sections.forEach((section, index) => {
      setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(`${index + 1}. ${section.title}`, { indent: 12 });
    });
    doc.moveDown(0.8);

    for (const section of dossier.sections) {
      if (doc.y > 650) doc.addPage();
      setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(section.title);
      doc.moveDown(0.2);
      setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(section.body, { align: 'justify' });
      doc.moveDown(0.8);
    }

    if (dossier.buildingRecords.length) {
      if (doc.y > 620) doc.addPage();
      setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(labelForLanguage('Building Documentation', 'توثيق المباني', context.brand.languageMode));
      doc.moveDown(0.3);
      dossier.buildingRecords.forEach((building, index) => {
        setPdfFont(doc, true).fontSize(11).fillColor('#0f172a').text(`${index + 1}. ${building.name}`);
        setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(building.summary, { align: 'justify' });
        doc.moveDown(0.45);
      });
    }

    if (dossier.references.length) {
      if (doc.y > 620) doc.addPage();
      setPdfFont(doc, true).fontSize(13).fillColor(context.brand.primaryColor).text(labelForLanguage('References', 'المراجع', context.brand.languageMode));
      doc.moveDown(0.25);
      dossier.references.forEach(ref => {
        setPdfFont(doc, false).fontSize(9).fillColor('#334155').text(`${ref.title} - ${ref.note}`);
      });
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      setPdfFont(doc, false).fontSize(8).fillColor('#64748b').text(
        `Page ${i + 1} of ${range.count}`,
        40,
        doc.page.height - 26,
        { align: 'center', width: doc.page.width - 80 },
      );
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildWordBuildingDocument(building, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const groupedTypes = building.assets.reduce((acc, asset) => {
    acc[asset.type] = (acc[asset.type] || 0) + 1;
    return acc;
  }, {});

  const children = [
    new Paragraph({ text: building.name, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: building.summary, alignment: AlignmentType.CENTER }),
    new Paragraph({ text: labelForLanguage('Asset Summary', 'ملخص الأصول', context.brand.languageMode), heading: HeadingLevel.HEADING_1 }),
  ];

  Object.entries(groupedTypes).forEach(([type, count]) => {
    children.push(new Paragraph({ text: `${type}: ${count}` }));
  });

  children.push(new Paragraph({ text: labelForLanguage('Implementation Notes', 'ملاحظات التنفيذ', context.brand.languageMode), heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: `This building file was prepared as part of ${context.brand.projectName}. Available evidence has been grouped for presentation, review, and downstream editing.` }));

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);
}

async function buildPdfBuildingDocument(building, context, imagePath, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    setPdfFont(doc, true).fontSize(22).fillColor(context.brand.primaryColor).text(building.name, { align: 'center' });
    doc.moveDown(0.3);
    setPdfFont(doc, false).fontSize(10).fillColor('#475569').text(context.brand.projectName, { align: 'center' });
    doc.moveDown(0.8);

    if (imagePath && fs.existsSync(imagePath)) {
      try {
        doc.image(imagePath, { fit: [515, 230], align: 'center' });
        doc.moveDown(0.8);
      } catch (error) {
        // Non-fatal image issue.
      }
    }

    setPdfFont(doc, false).fontSize(10).fillColor('#334155').text(building.summary, { align: 'justify' });
    doc.moveDown(0.6);
    setPdfFont(doc, true).fontSize(13).fillColor('#0f172a').text(labelForLanguage('Available Content', 'المحتوى المتاح', context.brand.languageMode));
    doc.moveDown(0.2);

    building.assets.slice(0, 20).forEach(asset => {
      setPdfFont(doc, false).fontSize(9).fillColor('#334155').text(`- ${asset.name} (${asset.type})`);
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

  const summary = workbook.addWorksheet('Project Summary');
  summary.columns = [{ header: 'Field', width: 28 }, { header: 'Value', width: 70 }];
  [
    ['Project Name', context.brand.projectName],
    ['Implementing Body', context.brand.implementingBody],
    ['Preparation Date', context.brand.preparationDate],
    ['Consultant Team', context.brand.consultantTeam],
    ['Language Mode', context.brand.languageMode],
    ['Assets Indexed', contentModel.counts.totalAssets],
    ['Images', contentModel.counts.images],
    ['Reports', contentModel.counts.reports],
    ['Models', contentModel.counts.models],
    ['Presentations', contentModel.counts.presentations],
  ].forEach(row => summary.addRow(row));

  const assets = workbook.addWorksheet('Asset Register');
  assets.columns = [
    { header: 'Service', width: 28 },
    { header: 'Building', width: 28 },
    { header: 'District', width: 28 },
    { header: 'File', width: 42 },
    { header: 'Type', width: 18 },
    { header: 'Usage', width: 24 },
    { header: 'Size KB', width: 12 },
  ];
  contentModel.assets.forEach(asset => {
    assets.addRow([
      asset.serviceName,
      asset.building,
      asset.district,
      asset.name,
      asset.type,
      asset.usage,
      asset.sizeKB,
    ]);
  });

  const outputs = workbook.addWorksheet('Generated Outputs');
  outputs.columns = [
    { header: 'Label', width: 34 },
    { header: 'Relative Path', width: 60 },
    { header: 'Extension', width: 14 },
  ];
  deliverables.forEach(file => outputs.addRow([file.label, file.relativePath, file.ext]));

  const buildings = workbook.addWorksheet('Buildings');
  buildings.columns = [
    { header: 'Building', width: 34 },
    { header: 'Summary', width: 90 },
  ];
  dossier.buildingRecords.forEach(building => buildings.addRow([building.name, building.summary]));

  await workbook.xlsx.writeFile(outPath);
}

function buildInfographicSvg(context, contentModel, dossier) {
  const serviceBlocks = Object.entries(contentModel.byService)
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
  <text x="84" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">Indexed project assets</text>
  <text x="430" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#38bdf8">${dossier.buildingRecords.length}</text>
  <text x="430" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">Building document groups</text>
  <text x="760" y="220" font-size="64" font-family="Arial" font-weight="700" fill="#10b981">${contentModel.counts.html + contentModel.counts.presentations + contentModel.counts.models}</text>
  <text x="760" y="250" font-size="18" font-family="Arial" fill="#e2e8f0">Digital and presentation outputs</text>
  ${serviceBlocks}
  <text x="84" y="740" font-size="18" font-family="Arial" fill="#f8fafc">Coverage</text>
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
    `Project: ${context.brand.projectName}`,
    `Style direction: ${context.project.brandingPreferences}`,
    '',
    'Suggested short promo structure:',
    '1. Opening title card with project identity and implementing body.',
    '2. Present the heritage context with restored visuals and key urban imagery.',
    '3. Highlight architectural visualizations, building plans, and analytical reports.',
    '4. Introduce 3D models, digital portfolio outputs, and implementation readiness.',
    '5. Close with the dossier, delivery package, and project impact statement.',
    '',
    `Voiceover draft: ${dossier.executiveSummary}`,
    '',
    'Key figures:',
    `- Total indexed assets: ${contentModel.counts.totalAssets}`,
    `- Building groups: ${dossier.buildingRecords.length}`,
    `- Models: ${contentModel.counts.models}`,
    `- Reports: ${contentModel.counts.reports}`,
  ].join('\n');
}

function buildSocialCaptions(context, contentModel) {
  return [
    `Caption 1: ${context.brand.projectName} now includes a complete documentation and media package integrating restored imagery, heritage analysis, plans, reports, and 3D assets.`,
    `Caption 2: From restoration to presentation-ready delivery, the package organizes ${contentModel.counts.totalAssets} outputs into a professional handover format for review, publication, and digital sharing.`,
    `Caption 3: The project portfolio supports dossier preparation, building-level documentation, interactive browsing, and media-ready communication assets.`,
  ].join('\n\n');
}

function buildPortfolioHtml(context, dossier, copiedAssets, outPath) {
  const htmlDir = path.dirname(outPath);
  const heroImages = copiedAssets.filter(asset => asset.type === 'image').slice(0, 8);
  const mapFrames = copiedAssets.filter(asset => asset.usage === 'interactive-map').slice(0, 2);
  const modelFrames = copiedAssets.filter(asset => asset.usage === 'interactive-viewer').slice(0, 2);
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
      <span class="eyebrow">${xmlEscape(SERVICE_06_NAME)}</span>
      <h1>${xmlEscape(context.brand.projectName)}</h1>
      <p>${xmlEscape(dossier.executiveSummary)}</p>
      <div class="grid">
        <div class="panel"><strong>${copiedAssets.length}</strong><p>Packaged files copied into the structured delivery folder.</p></div>
        <div class="panel"><strong>${dossier.buildingRecords.length}</strong><p>Building-level documentation groups.</p></div>
        <div class="panel"><strong>${Object.keys(context.contentModel.byService).length}</strong><p>Integrated service sources.</p></div>
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
      <div class="embeds">${iframeBlocks || '<div class="panel"><p>No interactive HTML outputs were linked. The package still includes standalone files and structured navigation.</p></div>'}</div>
    </section>
  </div>
</body>
</html>`;

  fs.writeFileSync(outPath, html);
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

function buildResponsePreview(context, dossier, contentModel, outputFiles) {
  return {
    title: context.brand.projectName,
    dossierTitle: dossier.title,
    assetCount: contentModel.counts.totalAssets,
    buildingDocuments: dossier.buildingRecords.length,
    generatedOutputs: outputFiles.length,
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
    const contentModel = buildContentModel(context.project, dedupedJobs, uploadedFilesSummary);
    context.contentModel = contentModel;
    const dossier = buildDossierModel(context, dedupedJobs, contentModel);

    const packageRootName = `RUAA_Project_${slugify(context.brand.projectName, 'project')}`;
    const packageRoot = path.join(jobDir, packageRootName);
    ensureDir(packageRoot);

    const copiedAssets = copyAssetsIntoPackage(packageRoot, contentModel, context.brand);
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
      .filter(asset => asset.copiedPath && isWebReadyImage(fileExt(asset.copiedPath)))
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
      buildSimplePptx([
        {
          title: building.name,
          subtitle: building.summary,
          imagePath,
        },
        {
          title: 'Available Outputs',
          subtitle: building.assets.slice(0, 10).map(asset => `${asset.name} (${asset.type})`).join(' | ') || 'No building-specific files were indexed.',
          imagePath: null,
        },
      ], building.name, buildingPptPath);

      buildingOutputs.push(
        { label: `${building.name} (Word)`, path: buildingWordPath },
        { label: `${building.name} (PDF)`, path: buildingPdfPath },
        { label: `${building.name} (PPTX)`, path: buildingPptPath },
      );
    }

    buildSimplePptx([
      {
        title: context.brand.projectName,
        subtitle: dossier.executiveSummary,
        imagePath: representativeImages[0]?.path || null,
      },
      {
        title: 'Documentation Scope',
        subtitle: dossier.methodology,
        imagePath: representativeImages[1]?.path || null,
      },
      {
        title: 'Building Files',
        subtitle: dossier.buildingRecords.map(building => building.name).join(' | ') || 'General project package',
        imagePath: representativeImages[2]?.path || null,
      },
    ], context.brand.projectName, projectPptPath);

    const infographicPaths = await buildInfographics(context, contentModel, dossier, mediaDir);
    fs.writeFileSync(promoScriptPath, buildPromoScript(context, dossier, contentModel));
    fs.writeFileSync(captionsPath, buildSocialCaptions(context, contentModel));
    fs.writeFileSync(userGuidePath, [
      `${context.brand.projectName} - User Guide`,
      '',
      '1. Open the PDF dossier for official review or printing.',
      '2. Open the DOCX dossier when editable narrative formatting is required.',
      '3. Use the PPTX deck for presentation and stakeholder briefing.',
      '4. Open 07_Digital_Portfolio/HTML_Website/index.html for the portfolio microsite.',
      '5. Review 04_Reports/Data_Excel/generated_outputs.xlsx for the full output inventory.',
      '6. Review 08_Media/Videos for script-ready promotional content.',
    ].join('\n'));

    buildPortfolioHtml(context, dossier, copiedAssets, portfolioHtmlPath);

    const generatedDeliverables = [
      { label: 'Main Dossier (PDF)', path: dossierPdfPath },
      { label: 'Main Dossier (Word)', path: dossierWordPath },
      { label: 'Project Summary (PPTX)', path: projectPptPath },
      { label: 'Digital Portfolio (HTML)', path: portfolioHtmlPath },
      { label: 'Infographic (SVG)', path: infographicPaths.svgPath },
      { label: 'Infographic (PNG)', path: infographicPaths.pngPath },
      { label: 'Infographic (PDF)', path: infographicPaths.pdfPath },
      { label: 'Promo Script', path: promoScriptPath },
      { label: 'Social Captions', path: captionsPath },
      { label: 'User Guide', path: userGuidePath },
      ...buildingOutputs,
    ].map(item => ({
      ...item,
      ext: fileExt(item.path).slice(1) || 'txt',
      relativePath: toWebPath(path.relative(packageRoot, item.path)),
    }));

    await buildExcelManifest(context, dossier, contentModel, generatedDeliverables, outputManifestPath);
    generatedDeliverables.push({
      label: 'Generated Outputs Manifest (Excel)',
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
        service: job.service,
        serviceName: job.serviceName,
        title: job.title,
      })),
      contentModel: {
        counts: contentModel.counts,
        byType: contentModel.byType,
        byService: contentModel.byService,
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
        'Service 06 fully handles local aggregation, indexing, folder packaging, PDF/Word/PPTX/HTML generation, infographics, and script-ready media support.',
        'Rendered MP4 video generation, studio-grade voiceover synthesis, and advanced live 3D/map embedding beyond linked HTML assets would require additional runtime tooling or external APIs.',
      ],
    };

    fs.writeFileSync(metadataSummaryPath, JSON.stringify(metadata, null, 2));
    generatedDeliverables.push({
      label: 'Package Manifest (JSON)',
      path: metadataSummaryPath,
      ext: 'json',
      relativePath: toWebPath(path.relative(packageRoot, metadataSummaryPath)),
    });

    fs.writeFileSync(readmePath, buildReadmeText(context, dossier, generatedDeliverables, packageRootName));
    generatedDeliverables.push({
      label: 'README',
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
        label: 'Delivery Bundle (ZIP)',
        url: relOutputUrl(jobId, bundleZipPath),
        ext: 'zip',
      },
    ];

    const metaPath = path.join(jobDir, 'metadata.json');
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, outputFiles }, null, 2));
    outputFiles.push({
      label: 'Service 06 Metadata (JSON)',
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
