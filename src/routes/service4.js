'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

let OpenAI;
try {
  OpenAI = require('openai');
} catch (error) {
  OpenAI = null;
}

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

const SERVICE_04_NAME = 'Automated Academic Reporting';
const SERVICE_04_DEFINITION = 'Generate structured academic, professional, and government-style heritage reports by synthesizing outputs from Services 01, 02, and 03 with project metadata, heritage significance, condition assessments, rehabilitation strategies, and standards-based reasoning.';

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
const PDF_FONT_REGULAR = 'C:\\Windows\\Fonts\\arial.ttf';
const PDF_FONT_BOLD = 'C:\\Windows\\Fonts\\arialbd.ttf';

[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `s4_${Date.now()}_${uuidv4().slice(0, 8)}${path.extname(file.originalname).toLowerCase()}`),
});

const ALLOWED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.json', '.geojson', '.kml', '.kmz', '.svg', '.dxf',
  '.glb', '.gltf', '.fbx', '.obj', '.stl', '.txt',
]);

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 50 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ext || ALLOWED_EXTENSIONS.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

const STANDARD_LIBRARY = {
  unesco: [
    {
      code: 'UNESCO-HUL-2011',
      title: 'UNESCO Recommendation on the Historic Urban Landscape',
      year: '2011',
      scope: 'Urban context, layered values, and integrated conservation management.',
      note: 'Use landscape-scale conservation thinking when the project includes district, setting, or urban relationships.',
    },
    {
      code: 'WH-OG',
      title: 'Operational Guidelines for the Implementation of the World Heritage Convention',
      year: 'current edition',
      scope: 'Authenticity, integrity, protection, management, and monitoring.',
      note: 'Apply as a reference framework for significance, protection, and management planning.',
    },
    {
      code: 'VENICE-1964',
      title: 'ICOMOS Venice Charter',
      year: '1964',
      scope: 'Respect for historic fabric, documentary evidence, and minimum necessary intervention.',
      note: 'Useful for framing intervention limits and conservation ethics.',
    },
    {
      code: 'BURRA-2013',
      title: 'The Burra Charter',
      year: '2013',
      scope: 'Conservation planning based on cultural significance and compatible use.',
      note: 'Useful when adaptive reuse is part of the project brief.',
    },
  ],
  saudi: [
    {
      code: 'HC-DOC',
      title: 'Saudi Heritage Commission documentation and conservation approval workflow',
      year: 'project-specific',
      scope: 'Documentation completeness, significance recording, intervention review, and official submission readiness.',
      note: 'Final regulatory language should be validated against the latest project-specific submission requirements.',
    },
    {
      code: 'SBC-ADAPT',
      title: 'Applicable Saudi Building Code and life-safety provisions for adaptive reuse',
      year: 'project-specific',
      scope: 'Occupancy, accessibility, life safety, structural stability, and services coordination.',
      note: 'Use as an implementation checkpoint alongside heritage review.',
    },
  ],
  sustainability: [
    {
      code: 'SDG-11',
      title: 'UN Sustainable Development Goal 11',
      year: 'ongoing',
      scope: 'Inclusive, resilient, and sustainable cities and communities.',
      note: 'Useful for framing social value, resilience, and heritage-led urban regeneration.',
    },
    {
      code: 'CIRCULAR-REUSE',
      title: 'Circular rehabilitation and material stewardship practice',
      year: 'best practice',
      scope: 'Material retention, low-carbon retrofit logic, and lifecycle thinking.',
      note: 'Supports low-impact intervention strategies in heritage assets.',
    },
  ],
};

const REPORT_TYPE_LABELS = {
  documentation: 'Documentation Report',
  rehabilitation: 'Rehabilitation Report',
  feasibility: 'Feasibility Study',
};

const REPORT_MODE_LABELS = {
  academic: 'Academic Thesis Style',
  professional: 'Professional Report Style',
  government: 'Government Submission Style',
};

const LANGUAGE_LABELS = {
  arabic: 'Arabic',
  english: 'English',
  bilingual: 'Bilingual Arabic / English',
};

const DEPTH_LABELS = {
  brief: 'Brief',
  medium: 'Medium',
  comprehensive: 'Comprehensive',
};

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

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function compactText(value, maxLength = 320) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
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

function isWebReadyImage(ext) {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
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
  if (meta.imageCount) subtitleParts.push(`${meta.imageCount} images`);
  if (meta.viewsGenerated) subtitleParts.push(`${meta.viewsGenerated} views`);

  return {
    jobId,
    service: meta.service || null,
    serviceName: meta.serviceName || `Service ${meta.service || '?'}`,
    title,
    subtitle: subtitleParts.join(' | '),
    processedAt: meta.processedAt || '',
    reportable: [1, 2, 3].includes(meta.service),
  };
}

function discoverPreviousJobs() {
  const jobs = [];
  for (const jobId of listOutputJobDirectories()) {
    const metaPath = path.join(OUTPUTS_DIR, jobId, 'metadata.json');
    const meta = safeReadJson(metaPath);
    if (!meta || ![1, 2, 3].includes(meta.service)) continue;
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

  if (meta.service === 1 && Array.isArray(meta.images)) {
    for (const image of meta.images) {
      const candidate = image.upscaledUrl || image.restoredUrl || image.restoredJpgUrl || image.upscaledJpgUrl;
      if (!candidate) continue;
      const local = publicPathFromUrl(candidate);
      if (fs.existsSync(local)) imagePaths.push(local);
    }
  }

  if ((meta.service === 2 || meta.service === 3) && Array.isArray(meta.outputFiles)) {
    for (const file of meta.outputFiles) {
      if ((file.ext || '').toLowerCase() !== 'png') continue;
      const local = publicPathFromUrl(file.url);
      if (fs.existsSync(local)) imagePaths.push(local);
    }
  }

  if (!imagePaths.length) {
    for (const file of collectOutputFiles(jobDir)) {
      if (file.isImage) imagePaths.push(file.path);
    }
  }

  return [...new Set(imagePaths)].slice(0, 8);
}

function summarizeService1(meta = {}, jobDir) {
  const images = Array.isArray(meta.images) ? meta.images : [];
  return {
    jobId: meta.jobId || path.basename(jobDir),
    service: 1,
    serviceName: meta.serviceName || 'Visual Intelligence Restoration',
    stage: meta.stage || '',
    prompt: meta.prompt || '',
    imageCount: meta.imageCount || images.length,
    processedAt: meta.processedAt || '',
    outputs: images.map((image, index) => ({
      index: index + 1,
      originalName: image.originalName || `Image ${index + 1}`,
      restoredUrl: image.restoredUrl || '',
      upscaledUrl: image.upscaledUrl || '',
    })),
    representativeImages: getRepresentativeImagePaths(meta, jobDir),
  };
}

function summarizeService2(meta = {}, jobDir) {
  const styleAnalysis = meta.styleAnalysis || {};
  return {
    jobId: meta.jobId || path.basename(jobDir),
    service: 2,
    serviceName: meta.serviceName || 'Architectural Rehabilitation Visualization',
    buildingName: meta.buildingName || '',
    style: meta.style || '',
    buildingType: meta.buildingType || '',
    area: meta.area || '',
    floors: meta.floors || '',
    referenceInputs: meta.referenceInputs || {},
    viewsGenerated: meta.viewsGenerated || 0,
    styleAnalysis: {
      detectedStyle: styleAnalysis.detectedStyle || '',
      confidence: styleAnalysis.confidence || '',
      elements: styleAnalysis.elements || [],
      heritageValue: styleAnalysis.heritageValue || '',
      notes: styleAnalysis.notes || '',
      reuseGuidance: styleAnalysis.reuseGuidance || '',
    },
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
    urbanAnalysis: {
      detectedStyle: urbanAnalysis.detectedStyle || '',
      urbanPattern: urbanAnalysis.urbanPattern || '',
      keyFeatures: urbanAnalysis.keyFeatures || [],
      heritageValue: urbanAnalysis.heritageValue || '',
      restorationNotes: urbanAnalysis.restorationNotes || '',
    },
    districtSummary: meta.districtSummary || {},
    terrainSummary: meta.terrainSummary || {},
    restorationAssetSummary: meta.restorationAssetSummary || {},
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
      if (parsed && [1, 2, 3].includes(parsed.service)) {
        parsedMetadata.push(parsed);
      }
    }

    return {
      originalName: file.originalname,
      storedPath: file.path,
      ext: ext.slice(1),
      sizeKB: Math.round((file.size || 0) / 1024),
      category: isImageExtension(ext)
        ? 'image'
        : ['.glb', '.gltf', '.fbx', '.obj', '.stl'].includes(ext)
          ? 'model'
          : ['.geojson', '.json', '.kml', '.kmz', '.dxf', '.svg'].includes(ext)
            ? 'data'
            : 'document',
    };
  });

  return {
    totalFiles: items.length,
    images: items.filter(item => item.category === 'image').length,
    documents: items.filter(item => item.category === 'document').length,
    models: items.filter(item => item.category === 'model').length,
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

  if (![1, 2, 3].includes(meta.service)) {
    throw new Error(`Job "${jobId}" is not a reportable Service 01/02/03 output.`);
  }

  if (meta.service === 1) return summarizeService1(meta, jobDir);
  if (meta.service === 2) return summarizeService2(meta, jobDir);
  return summarizeService3(meta, jobDir);
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

function buildStandardsProfile(standardProfile = 'both') {
  const profile = normalizeText(standardProfile, 'both').toLowerCase();
  const base = [];

  if (profile === 'unesco') {
    base.push(...STANDARD_LIBRARY.unesco);
  } else if (profile === 'saudi') {
    base.push(...STANDARD_LIBRARY.saudi);
  } else {
    base.push(...STANDARD_LIBRARY.unesco, ...STANDARD_LIBRARY.saudi);
  }

  base.push(...STANDARD_LIBRARY.sustainability);
  return base;
}

function pickRepresentativeImages(linkedJobs, uploadedFilesSummary, limit = 6) {
  const images = [];

  for (const job of linkedJobs) {
    for (const imagePath of job.representativeImages || []) {
      if (fs.existsSync(imagePath) && isWebReadyImage(fileExt(imagePath))) {
        images.push({
          path: imagePath,
          source: job.serviceName,
          caption: `${job.serviceName} evidence`,
        });
      }
      if (images.length >= limit) break;
    }
    if (images.length >= limit) break;
  }

  if (images.length < limit) {
    for (const file of uploadedFilesSummary.items || []) {
      if (file.category !== 'image' || !fs.existsSync(file.storedPath) || !isWebReadyImage(fileExt(file.storedPath))) continue;
      images.push({
        path: file.storedPath,
        source: 'Uploaded supporting file',
        caption: file.originalName,
      });
      if (images.length >= limit) break;
    }
  }

  return images.slice(0, limit);
}

function buildSectionSkeleton(context) {
  const sections = [
    { id: 'project_overview', title: 'Project Overview' },
    { id: 'historical_background', title: 'Historical Background' },
    { id: 'architectural_description', title: 'Architectural Description' },
    { id: 'condition_assessment', title: 'Condition Assessment' },
    { id: 'heritage_value', title: 'Heritage Value Assessment' },
    { id: 'urban_context', title: 'Geospatial and Urban Context' },
    { id: 'rehabilitation_strategy', title: 'Rehabilitation Strategy' },
    { id: 'proposed_interventions', title: 'Proposed Interventions' },
    { id: 'sustainability', title: 'Sustainability Considerations' },
    { id: 'standards_compliance', title: 'Standards and Compliance' },
    { id: 'implementation', title: 'Implementation Recommendations' },
    { id: 'conclusion', title: 'Conclusion' },
  ];

  if (context.report.type === 'feasibility') {
    sections.splice(8, 0, { id: 'feasibility', title: 'Feasibility and Delivery Considerations' });
  }

  return sections;
}

function buildModelContext(input, linkedJobs, uploadedFilesSummary) {
  const service1 = linkedJobs.find(job => job.service === 1) || null;
  const service2 = linkedJobs.find(job => job.service === 2) || null;
  const service3 = linkedJobs.find(job => job.service === 3) || null;

  const context = {
    project: {
      buildingName: normalizeText(input.buildingName, 'Unnamed heritage asset'),
      location: normalizeText(input.location, 'Location not provided'),
      approximateDate: normalizeText(input.approximateDate, 'Date not provided'),
      currentCondition: normalizeText(input.currentCondition, 'Condition not provided'),
      historicalBackground: normalizeMultiline(input.historicalBackground),
      architecturalStyle: normalizeText(input.architecturalStyle, service2?.style || ''),
      heritageSignificance: normalizeMultiline(input.heritageSignificance),
      conditionAndDamage: normalizeMultiline(input.conditionAndDamage),
      rehabilitationStrategy: normalizeMultiline(input.rehabilitationStrategy),
      targetFunction: normalizeText(input.targetFunction, service2?.buildingType || 'Not provided'),
      adaptiveReuseConcept: normalizeMultiline(input.adaptiveReuseConcept),
      geographicContext: normalizeMultiline(input.geographicContext),
      notes: normalizeMultiline(input.notes, ''),
    },
    report: {
      type: normalizeText(input.reportType, 'rehabilitation'),
      mode: normalizeText(input.reportMode, 'professional'),
      language: normalizeText(input.language, 'english'),
      depth: normalizeText(input.depth, 'medium'),
      standardsProfile: normalizeText(input.standardProfile, 'both'),
    },
    linkedServices: {
      service1,
      service2,
      service3,
      all: linkedJobs,
    },
    uploadedEvidence: uploadedFilesSummary,
  };

  context.standards = buildStandardsProfile(context.report.standardsProfile);
  context.sections = buildSectionSkeleton(context);
  context.representativeImages = pickRepresentativeImages(linkedJobs, uploadedFilesSummary, 6);
  context.evidenceSummary = {
    linkedJobs: linkedJobs.length,
    linkedServices: linkedJobs.map(job => ({ service: job.service, jobId: job.jobId, name: job.serviceName })),
    uploadedFiles: uploadedFilesSummary.totalFiles,
    representativeImages: context.representativeImages.length,
  };

  return context;
}

function parseJsonResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty model response.');

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const jsonChunk = candidate.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonChunk ? jsonChunk[0] : candidate);
}

function buildPromptBundle(context) {
  const paragraphsByDepth = {
    brief: '1 concise paragraph per section',
    medium: '2 analytical paragraphs per section',
    comprehensive: '3-4 well-developed paragraphs per section',
  };

  const modeTone = {
    academic: 'formal, analytical, thesis-grade',
    professional: 'formal, concise, consultant-style',
    government: 'formal, policy-aware, submission-ready',
  };

  const languageInstruction = {
    arabic: 'Write the entire report in Arabic.',
    english: 'Write the entire report in English.',
    bilingual: 'Write each section in bilingual format: Arabic first, then English.',
  };

  const contextForModel = {
    project: context.project,
    report: {
      ...context.report,
      reportTypeLabel: REPORT_TYPE_LABELS[context.report.type] || context.report.type,
      reportModeLabel: REPORT_MODE_LABELS[context.report.mode] || context.report.mode,
      languageLabel: LANGUAGE_LABELS[context.report.language] || context.report.language,
      depthLabel: DEPTH_LABELS[context.report.depth] || context.report.depth,
    },
    linkedServices: context.linkedServices,
    evidenceSummary: context.evidenceSummary,
    standards: context.standards,
    sections: context.sections,
  };

  const systemPrompt = [
    'You are a heritage conservation reporting specialist.',
    'Write like a real academic, professional, or governmental heritage consultant.',
    'Use only the supplied project context and state limitations when information is missing.',
    'Do not fabricate measurements, dates, legal approvals, or citations beyond the provided frameworks.',
    'Return valid JSON only.',
  ].join(' ');

  const userPrompt = [
    `Prepare a ${REPORT_MODE_LABELS[context.report.mode] || context.report.mode} ${REPORT_TYPE_LABELS[context.report.type] || context.report.type}.`,
    languageInstruction[context.report.language] || languageInstruction.english,
    `Depth requirement: ${paragraphsByDepth[context.report.depth] || paragraphsByDepth.medium}.`,
    `Tone: ${modeTone[context.report.mode] || modeTone.professional}.`,
    'Organize the report into the requested sections and keep the writing formal, evidence-based, and heritage-aware.',
    'For standards and compliance, discuss framework relevance, likely alignment, and any validation still required.',
    'For sustainability, address environmental, social, and economic dimensions where relevant.',
    'Return only this JSON shape:',
    JSON.stringify({
      title: 'string',
      executiveSummary: 'string',
      abstract: 'string',
      keywords: ['string'],
      sections: [{
        id: 'section id',
        title: 'section title',
        body: 'section body',
        keyPoints: ['bullet 1', 'bullet 2'],
      }],
      standardsChecklist: [{
        framework: 'string',
        principle: 'string',
        application: 'string',
        status: 'aligned | partial | pending verification',
      }],
      sustainabilityMatrix: [{
        dimension: 'environmental/social/economic',
        consideration: 'string',
        projectResponse: 'string',
      }],
      implementationRecommendations: [{
        phase: 'string',
        priority: 'high/medium/low',
        recommendation: 'string',
        deliverable: 'string',
      }],
      references: [{
        title: 'string',
        year: 'string',
        note: 'string',
      }],
      appendixSuggestions: ['string'],
    }, null, 2),
    'Project context:',
    JSON.stringify(contextForModel, null, 2),
  ].join('\n\n');

  return { systemPrompt, userPrompt };
}

async function generateWithOpenAI(context) {
  if (!OpenAI || !process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI provider is not configured.');
  }

  const { systemPrompt, userPrompt } = buildPromptBundle(context);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.SERVICE_04_OPENAI_MODEL || 'gpt-4o-mini';

  const completion = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    temperature: 0.3,
    messages: [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || '{}';
  return {
    provider: 'openai',
    model,
    report: parseJsonResponse(content),
  };
}

async function generateWithReplicate(context) {
  if (!Replicate || !process.env.REPLICATE_API_TOKEN) {
    throw new Error('Replicate provider is not configured.');
  }

  const { systemPrompt, userPrompt } = buildPromptBundle(context);
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const imageInputs = context.representativeImages
    .filter(item => fs.existsSync(item.path))
    .slice(0, 6)
    .map(item => fileToDataUri(item.path));

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: systemPrompt,
      prompt: userPrompt,
      image_input: imageInputs,
      temperature: 0.25,
      max_completion_tokens: 3500,
    },
  });

  const text = Array.isArray(output) ? output.join('') : String(output || '');
  return {
    provider: 'replicate',
    model: 'openai/gpt-4o',
    report: parseJsonResponse(text),
  };
}

function buildTemplateReport(context) {
  const title = `${context.project.buildingName} - ${REPORT_TYPE_LABELS[context.report.type] || 'Heritage Report'}`;
  const service1 = context.linkedServices.service1;
  const service2 = context.linkedServices.service2;
  const service3 = context.linkedServices.service3;

  const sectionBodies = {
    project_overview: `This report documents the heritage asset "${context.project.buildingName}" located in ${context.project.location}. The reporting brief is framed as a ${REPORT_TYPE_LABELS[context.report.type] || 'heritage report'} prepared in ${REPORT_MODE_LABELS[context.report.mode] || 'professional'} mode. The report synthesizes project metadata together with any linked outputs from Services 01, 02, and 03 to support documentation, planning, and decision-making.`,
    historical_background: `Available background information indicates the asset dates to ${context.project.approximateDate}. The supplied historical background states: ${context.project.historicalBackground} The historical record should be treated as a working basis for documentation and may require archival verification where precise dates, phases of construction, or ownership history are still incomplete.`,
    architectural_description: `The architectural character is currently described as ${context.project.architecturalStyle || 'not fully specified'}. ${service2 ? `Service 02 identified ${service2.styleAnalysis.detectedStyle || service2.style || 'a heritage architectural language'} and highlighted the following defining elements: ${(service2.styleAnalysis.elements || []).join(', ') || 'heritage-defining elements were not enumerated'}.` : 'No Service 02 visualization metadata was linked, so this section relies primarily on the user-provided description.'} The description should be read as a synthesis of project inputs and linked service outputs rather than a substitute for measured survey documentation.`,
    condition_assessment: `The current condition is described as ${context.project.currentCondition}. Observed damage and condition notes include: ${context.project.conditionAndDamage} ${service1 ? `Service 01 contributed ${service1.imageCount} visual restoration output(s), which support interpretation of deteriorated or incomplete visual evidence and provide a comparative basis for documenting lost or obscured details.` : 'No Service 01 restoration package was linked, so visual condition interpretation remains limited to the submitted description and attachments.'}`,
    heritage_value: `The heritage significance provided for the asset is summarized as follows: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `Service 02 further characterized the heritage value as ${service2.styleAnalysis.heritageValue}.` : ''} Heritage value should continue to guide the hierarchy of intervention so that the most significant materials, spatial relationships, and architectural attributes receive the strongest protection.`,
    urban_context: `${service3 ? `Service 03 contextualized the project within ${service3.districtName || 'its wider district'}${service3.city ? `, ${service3.city}` : ''}. The linked urban analysis describes the setting as ${service3.urbanAnalysis.urbanPattern || 'not fully classified'}, with key features including ${(service3.urbanAnalysis.keyFeatures || []).join(', ') || 'no specific features recorded'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `The geographic and urban context supplied for the asset is: ${context.project.geographicContext} No Service 03 dataset was linked, so district-scale interpretation remains dependent on the user's contextual note rather than formal geospatial analysis.`}`,
    rehabilitation_strategy: `The proposed rehabilitation strategy is articulated as follows: ${context.project.rehabilitationStrategy} The target function is ${context.project.targetFunction}, and the adaptive reuse concept is described as: ${context.project.adaptiveReuseConcept} The strategy should therefore balance conservation of character-defining attributes with the technical requirements of reuse, accessibility, safety, and ongoing maintenance.`,
    proposed_interventions: `Based on the supplied evidence, the intervention logic should prioritize documentation, stabilization, repair of damaged fabric, selective rehabilitation of service systems, and reuse-compatible upgrades. Intervention design should remain distinguishable in documentation while being materially and visually compatible with the historic character of the building. Additional specialist assessment is recommended for structure, materials conservation, building services, and code compliance before implementation.`,
    feasibility: `Feasibility depends on technical condition, reuse compatibility, regulatory acceptance, and budget/operations planning. The project should therefore be phased through documentation, investigation, urgent stabilization, design development, approvals, and implementation. A more detailed feasibility stage may also require cost estimation, stakeholder mapping, phasing analysis, and operational planning for the proposed target function.`,
    sustainability: `Sustainability in this project should be understood across environmental, social, and economic dimensions. Environmental value arises from retention of embodied carbon and material reuse; social value arises from continuity of heritage identity and public interpretation; economic value arises from adaptive reuse and long-term functionality. Sustainability performance should be strengthened through low-impact repair, durable material choices, maintenance planning, and climate-responsive retrofit decisions.`,
    standards_compliance: `The project should be interpreted against the selected standards profile while recognizing that formal compliance still requires project-specific review. The embedded framework set emphasizes cultural significance, minimum necessary intervention, authenticity, integrity, documentation quality, and compatible reuse. Where local approvals are required, the report should be treated as a submission-support document rather than a substitute for official regulatory review.`,
    implementation: `Implementation should proceed in phases: documentation and verification, specialist investigation, urgent stabilization, detailed design, approvals, rehabilitation works, and monitoring/maintenance. Early coordination should focus on the most vulnerable fabric and on clarifying which interventions are reversible, which are repair-based, and which require carefully justified adaptation for the new use.`,
    conclusion: `In conclusion, the project demonstrates clear potential for structured heritage rehabilitation provided that the intervention process remains evidence-led and significance-based. The linked service outputs provide useful visual, architectural, and contextual support, but final design and approval stages should continue to verify condition, regulation, and constructability in detail.`,
  };

  const sections = context.sections.map(section => ({
    id: section.id,
    title: section.title,
    body: sectionBodies[section.id] || 'Section content was not available.',
    keyPoints: [],
  }));

  return {
    title,
    executiveSummary: `This report consolidates available project metadata and linked heritage-service outputs for ${context.project.buildingName}. It frames the asset's significance, condition, rehabilitation strategy, contextual setting, and standards-based considerations in a structured reporting format suitable for documentation and planning.`,
    abstract: `The report synthesizes project metadata, prior service outputs, and standards references into a structured heritage reporting package for ${context.project.buildingName}. It supports documentation, rehabilitation planning, adaptive reuse reasoning, and official submission preparation.`,
    keywords: ['heritage conservation', 'adaptive reuse', 'rehabilitation strategy', 'heritage reporting'],
    sections,
    standardsChecklist: context.standards.map(item => ({
      framework: item.code,
      principle: item.title,
      application: item.scope,
      status: 'pending verification',
    })),
    sustainabilityMatrix: [
      {
        dimension: 'environmental',
        consideration: 'Retention of embodied material value',
        projectResponse: 'Prioritize repair, selective replacement, and low-impact material strategies.',
      },
      {
        dimension: 'social',
        consideration: 'Continuity of cultural identity and public value',
        projectResponse: 'Protect heritage character and align reuse with community interpretation and access.',
      },
      {
        dimension: 'economic',
        consideration: 'Long-term viability of adaptive reuse',
        projectResponse: 'Phase implementation and align interventions with maintainable operations.',
      },
    ],
    implementationRecommendations: [
      {
        phase: 'Documentation and verification',
        priority: 'high',
        recommendation: 'Complete archival, measured, and photographic documentation before major intervention.',
        deliverable: 'Verified base dossier and condition register',
      },
      {
        phase: 'Design development',
        priority: 'high',
        recommendation: 'Translate the rehabilitation strategy into phased, significance-led intervention packages.',
        deliverable: 'Coordinated rehabilitation design package',
      },
      {
        phase: 'Delivery and monitoring',
        priority: 'medium',
        recommendation: 'Establish maintenance and post-occupancy monitoring criteria.',
        deliverable: 'Maintenance and performance monitoring plan',
      },
    ],
    references: context.standards.map(item => ({
      title: item.title,
      year: item.year,
      note: item.note,
    })),
    appendixSuggestions: [
      'Comparative visual outputs from Service 01',
      'Architectural visualization sheets from Service 02',
      'Geospatial maps and urban context outputs from Service 03',
      'Condition photo log and intervention schedule',
    ],
  };
}

function ensureReportShape(report, context) {
  const sections = Array.isArray(report.sections) && report.sections.length
    ? report.sections
    : buildTemplateReport(context).sections;

  return {
    title: normalizeText(report.title, `${context.project.buildingName} - ${REPORT_TYPE_LABELS[context.report.type] || 'Heritage Report'}`),
    executiveSummary: normalizeMultiline(report.executiveSummary, 'Executive summary not generated.'),
    abstract: normalizeMultiline(report.abstract, 'Abstract not generated.'),
    keywords: Array.isArray(report.keywords) && report.keywords.length
      ? report.keywords
      : ['heritage conservation', 'rehabilitation', 'academic reporting'],
    sections: sections.map((section, index) => ({
      id: normalizeText(section.id, context.sections[index]?.id || `section_${index + 1}`),
      title: normalizeText(section.title, context.sections[index]?.title || `Section ${index + 1}`),
      body: normalizeMultiline(section.body, 'No narrative generated for this section.'),
      keyPoints: Array.isArray(section.keyPoints) ? section.keyPoints.filter(Boolean) : [],
    })),
    standardsChecklist: Array.isArray(report.standardsChecklist) ? report.standardsChecklist : [],
    sustainabilityMatrix: Array.isArray(report.sustainabilityMatrix) ? report.sustainabilityMatrix : [],
    implementationRecommendations: Array.isArray(report.implementationRecommendations) ? report.implementationRecommendations : [],
    references: Array.isArray(report.references) ? report.references : [],
    appendixSuggestions: Array.isArray(report.appendixSuggestions) ? report.appendixSuggestions : [],
  };
}

async function synthesizeReport(context) {
  const preferredProvider = normalizeText(process.env.SERVICE_04_PROVIDER, 'auto').toLowerCase();
  const providers = preferredProvider === 'openai'
    ? ['openai', 'replicate']
    : preferredProvider === 'replicate'
      ? ['replicate', 'openai']
      : ['replicate', 'openai'];

  const failures = [];

  for (const provider of providers) {
    try {
      const result = provider === 'openai'
        ? await generateWithOpenAI(context)
        : await generateWithReplicate(context);

      return {
        provider: result.provider,
        model: result.model,
        report: ensureReportShape(result.report, context),
      };
    } catch (error) {
      failures.push(`${provider}: ${error.message}`);
    }
  }

  return {
    provider: 'template',
    model: 'local-template',
    report: ensureReportShape(buildTemplateReport(context), context),
    warnings: failures,
  };
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

async function buildWordReport(report, context, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const children = [
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${SERVICE_04_NAME} | `, bold: true }),
        new TextRun(`${REPORT_TYPE_LABELS[context.report.type] || context.report.type} | ${REPORT_MODE_LABELS[context.report.mode] || context.report.mode}`),
      ],
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Location: ', bold: true }),
        new TextRun(context.project.location),
      ],
    }),
    new Paragraph({
      children: [
        new TextRun({ text: 'Generated: ', bold: true }),
        new TextRun(new Date().toLocaleString()),
      ],
    }),
    new Paragraph({ text: '' }),
    new Paragraph({
      text: 'Executive Summary',
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({ text: report.executiveSummary }),
    new Paragraph({
      text: 'Abstract',
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({ text: report.abstract }),
  ];

  for (const section of report.sections) {
    children.push(
      new Paragraph({
        text: section.title,
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({ text: section.body }),
    );

    if (section.keyPoints.length) {
      for (const point of section.keyPoints) {
        children.push(new Paragraph({ text: `• ${point}` }));
      }
    }
  }

  if (report.standardsChecklist.length) {
    children.push(new Paragraph({ text: 'Standards and Compliance Matrix', heading: HeadingLevel.HEADING_1 }));
    for (const item of report.standardsChecklist) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${item.framework}: `, bold: true }),
          new TextRun(`${item.principle} | ${item.status}`),
        ],
      }));
      children.push(new Paragraph({ text: item.application || '' }));
    }
  }

  if (report.implementationRecommendations.length) {
    children.push(new Paragraph({ text: 'Implementation Recommendations', heading: HeadingLevel.HEADING_1 }));
    for (const item of report.implementationRecommendations) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${item.phase} (${item.priority})`, bold: true }),
        ],
      }));
      children.push(new Paragraph({ text: `${item.recommendation} Deliverable: ${item.deliverable}` }));
    }
  }

  if (report.references.length) {
    children.push(new Paragraph({ text: 'References', heading: HeadingLevel.HEADING_1 }));
    for (const ref of report.references) {
      children.push(new Paragraph({ text: `${ref.title} (${ref.year}). ${ref.note}` }));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
}

async function buildPdfReport(report, context, images, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    setPdfFont(doc, true).fontSize(20).text(report.title, { align: 'center' });
    doc.moveDown(0.5);
    setPdfFont(doc, false).fontSize(10).text(`${SERVICE_04_NAME} | ${REPORT_TYPE_LABELS[context.report.type] || context.report.type}`, { align: 'center' });
    doc.text(`${context.project.location} | ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    if (images[0] && fs.existsSync(images[0].path)) {
      try {
        doc.image(images[0].path, { fit: [515, 220], align: 'center' });
        doc.moveDown(0.5);
      } catch (error) {
        // Ignore image rendering issues and continue with text.
      }
    }

    setPdfFont(doc, true).fontSize(14).text('Executive Summary');
    doc.moveDown(0.3);
    setPdfFont(doc, false).fontSize(10).text(report.executiveSummary, { align: 'justify' });
    doc.moveDown(0.8);

    for (const section of report.sections) {
      setPdfFont(doc, true).fontSize(13).text(section.title);
      doc.moveDown(0.25);
      setPdfFont(doc, false).fontSize(10).text(section.body, { align: 'justify' });
      doc.moveDown(0.5);

      for (const point of section.keyPoints || []) {
        setPdfFont(doc, false).fontSize(9).text(`• ${point}`, { indent: 12 });
      }

      doc.moveDown(0.8);
      if (doc.y > 700) doc.addPage();
    }

    if (report.references.length) {
      setPdfFont(doc, true).fontSize(13).text('References');
      doc.moveDown(0.3);
      for (const ref of report.references) {
        setPdfFont(doc, false).fontSize(9).text(`${ref.title} (${ref.year}) - ${ref.note}`);
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      setPdfFont(doc, false).fontSize(8).text(
        `Page ${i + 1} of ${range.count}`,
        40,
        doc.page.height - 28,
        { align: 'center', width: doc.page.width - 80 },
      );
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildExcelReport(report, context, linkedJobs, outPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_04_NAME;
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Project Summary');
  summary.columns = [{ width: 28 }, { width: 60 }];
  summary.addRow(['Field', 'Value']).font = { bold: true };
  [
    ['Building name', context.project.buildingName],
    ['Location', context.project.location],
    ['Approximate date', context.project.approximateDate],
    ['Current condition', context.project.currentCondition],
    ['Architectural style', context.project.architecturalStyle],
    ['Target function', context.project.targetFunction],
    ['Report type', REPORT_TYPE_LABELS[context.report.type] || context.report.type],
    ['Report mode', REPORT_MODE_LABELS[context.report.mode] || context.report.mode],
    ['Language', LANGUAGE_LABELS[context.report.language] || context.report.language],
    ['Depth', DEPTH_LABELS[context.report.depth] || context.report.depth],
  ].forEach(row => summary.addRow(row));

  const evidence = workbook.addWorksheet('Evidence Register');
  evidence.columns = [
    { header: 'Source', key: 'source', width: 18 },
    { header: 'Reference', key: 'reference', width: 28 },
    { header: 'Summary', key: 'summary', width: 80 },
  ];
  linkedJobs.forEach(job => {
    const summaryText = job.service === 1
      ? `${job.imageCount} visual restoration output(s)`
      : job.service === 2
        ? `${job.viewsGenerated} rehabilitation visualization(s)`
        : `${job.urbanAnalysis.urbanPattern || 'Urban'} context analysis`;
    evidence.addRow({
      source: job.serviceName,
      reference: job.jobId,
      summary: summaryText,
    });
  });

  const sections = workbook.addWorksheet('Report Sections');
  sections.columns = [
    { header: 'Section', key: 'section', width: 28 },
    { header: 'Body', key: 'body', width: 100 },
  ];
  report.sections.forEach(section => {
    sections.addRow({ section: section.title, body: section.body });
  });

  const compliance = workbook.addWorksheet('Compliance Matrix');
  compliance.columns = [
    { header: 'Framework', key: 'framework', width: 22 },
    { header: 'Principle', key: 'principle', width: 38 },
    { header: 'Application', key: 'application', width: 70 },
    { header: 'Status', key: 'status', width: 20 },
  ];
  report.standardsChecklist.forEach(item => compliance.addRow(item));

  const sustainability = workbook.addWorksheet('Sustainability');
  sustainability.columns = [
    { header: 'Dimension', key: 'dimension', width: 20 },
    { header: 'Consideration', key: 'consideration', width: 42 },
    { header: 'Project Response', key: 'projectResponse', width: 70 },
  ];
  report.sustainabilityMatrix.forEach(item => sustainability.addRow(item));

  const implementation = workbook.addWorksheet('Implementation');
  implementation.columns = [
    { header: 'Phase', key: 'phase', width: 28 },
    { header: 'Priority', key: 'priority', width: 16 },
    { header: 'Recommendation', key: 'recommendation', width: 60 },
    { header: 'Deliverable', key: 'deliverable', width: 40 },
  ];
  report.implementationRecommendations.forEach(item => implementation.addRow(item));

  const references = workbook.addWorksheet('References');
  references.columns = [
    { header: 'Title', key: 'title', width: 48 },
    { header: 'Year', key: 'year', width: 16 },
    { header: 'Note', key: 'note', width: 80 },
  ];
  report.references.forEach(item => references.addRow(item));

  await workbook.xlsx.writeFile(outPath);
}

async function buildPptxReport(report, context, images, outPath) {
  const slides = [
    {
      title: report.title,
      subtitle: compactText(report.executiveSummary, 220),
      imagePath: images[0]?.path || null,
    },
    {
      title: 'Project Overview',
      subtitle: compactText(report.sections.find(section => section.id === 'project_overview')?.body || report.abstract, 260),
      imagePath: images[1]?.path || images[0]?.path || null,
    },
    {
      title: 'Condition and Heritage Value',
      subtitle: compactText([
        report.sections.find(section => section.id === 'condition_assessment')?.body || '',
        report.sections.find(section => section.id === 'heritage_value')?.body || '',
      ].join(' '), 260),
      imagePath: images[2]?.path || images[0]?.path || null,
    },
    {
      title: 'Rehabilitation Strategy',
      subtitle: compactText([
        report.sections.find(section => section.id === 'rehabilitation_strategy')?.body || '',
        report.sections.find(section => section.id === 'proposed_interventions')?.body || '',
      ].join(' '), 260),
      imagePath: images[3]?.path || images[1]?.path || null,
    },
    {
      title: 'Standards and Sustainability',
      subtitle: compactText(
        report.standardsChecklist.slice(0, 3).map(item => `${item.framework}: ${item.status}`).join(' | ')
        || report.sustainabilityMatrix.slice(0, 2).map(item => `${item.dimension}: ${item.consideration}`).join(' | '),
        260,
      ),
      imagePath: images[4]?.path || images[0]?.path || null,
    },
    {
      title: 'Implementation Recommendations',
      subtitle: compactText(
        report.implementationRecommendations.map(item => `${item.phase}: ${item.recommendation}`).join(' | ')
        || report.sections.find(section => section.id === 'implementation')?.body
        || report.sections.find(section => section.id === 'conclusion')?.body,
        260,
      ),
      imagePath: images[5]?.path || images[2]?.path || null,
    },
  ];

  const imageEntries = [];
  const slideEntries = [];
  const slideRelEntries = [];
  const slideIdEntries = [];
  const presentationRelEntries = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];

  slides.forEach((slide, index) => {
    const slideNo = index + 1;
    const hasImage = slide.imagePath && fs.existsSync(slide.imagePath);
    const mediaName = hasImage ? `image${slideNo}${fileExt(slide.imagePath) || '.png'}` : '';

    slideIdEntries.push(`<p:sldId id="${255 + slideNo}" r:id="rId${slideNo + 1}"/>`);
    presentationRelEntries.push(`<Relationship Id="rId${slideNo + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`);

    const pictureXml = hasImage ? `
    <p:pic>
      <p:nvPicPr><p:cNvPr id="4" name="Picture ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="2800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
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
        <p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="${hasImage ? '4292600' : '1371600'}"/><a:ext cx="8229600" cy="${hasImage ? '685800' : '2400000'}"/></a:xfrm></p:spPr>
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
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(report.title)}</dc:title><dc:creator>Codex</dc:creator><cp:lastModifiedBy>Codex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`,
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
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="1A3554"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1A3554"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="DFAF67"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="10B981"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
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

function buildResponsePreview(report) {
  return {
    title: report.title,
    executiveSummary: report.executiveSummary,
    abstract: report.abstract,
    sectionTitles: report.sections.map(section => section.title),
    referencesCount: report.references.length,
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
    ...parseCsvList(req.body.service1JobId),
    ...parseCsvList(req.body.service2JobId),
    ...parseCsvList(req.body.service3JobId),
  ];

  let jobRecord = null;
  if (Job) {
    try {
      jobRecord = await Job.create({
        jobId,
        service: 4,
        status: 'processing',
        inputFiles: uploadedFiles.map(file => ({
          originalName: file.originalname,
          storedPath: file.path,
          sizeBytes: file.size,
        })),
        metadata: { request: req.body || {} },
      });
    } catch (error) {
      // Database persistence is optional for this app.
    }
  }

  try {
    const linkedJobs = [];
    for (const linkedJobId of serviceJobIds) {
      linkedJobs.push(loadJobContext(linkedJobId));
    }

    for (const parsedMeta of uploadedFilesSummary.parsedMetadata) {
      const tempJobDir = path.join(UPLOADS_DIR, '_virtual');
      if (parsedMeta.service === 1) linkedJobs.push(summarizeService1(parsedMeta, tempJobDir));
      if (parsedMeta.service === 2) linkedJobs.push(summarizeService2(parsedMeta, tempJobDir));
      if (parsedMeta.service === 3) linkedJobs.push(summarizeService3(parsedMeta, tempJobDir));
    }

    const dedupedJobs = dedupeByJobId(linkedJobs);
    const context = buildModelContext(req.body || {}, dedupedJobs, uploadedFilesSummary);
    const synthesis = await synthesizeReport(context);
    const report = synthesis.report;

    const reportJsonPath = path.join(jobDir, 'report.json');
    const docxPath = path.join(jobDir, 'academic_report.docx');
    const pdfPath = path.join(jobDir, 'academic_report.pdf');
    const xlsxPath = path.join(jobDir, 'report_tables.xlsx');
    const pptxPath = path.join(jobDir, 'presentation_summary.pptx');
    const metaPath = path.join(jobDir, 'metadata.json');

    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2));
    await buildWordReport(report, context, docxPath);
    await buildPdfReport(report, context, context.representativeImages, pdfPath);
    await buildExcelReport(report, context, dedupedJobs, xlsxPath);
    await buildPptxReport(report, context, context.representativeImages, pptxPath);

    const metadata = {
      jobId,
      service: 4,
      serviceName: SERVICE_04_NAME,
      serviceDefinition: SERVICE_04_DEFINITION,
      provider: synthesis.provider,
      model: synthesis.model,
      warnings: synthesis.warnings || [],
      reportProfile: {
        type: context.report.type,
        mode: context.report.mode,
        language: context.report.language,
        depth: context.report.depth,
        standardProfile: context.report.standardsProfile,
      },
      project: context.project,
      linkedJobs: dedupedJobs.map(job => ({
        jobId: job.jobId,
        service: job.service,
        serviceName: job.serviceName,
      })),
      uploadedEvidence: uploadedFilesSummary,
      representativeImages: context.representativeImages.map(item => ({
        source: item.source,
        caption: item.caption,
        path: item.path,
      })),
      generatedAt: new Date().toISOString(),
    };

    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

    const outputFiles = [
      { label: 'Structured Report (JSON)', url: relOutputUrl(jobId, reportJsonPath), ext: 'json' },
      { label: 'Academic Report (Word)', url: relOutputUrl(jobId, docxPath), ext: 'docx' },
      { label: 'Academic Report (PDF)', url: relOutputUrl(jobId, pdfPath), ext: 'pdf' },
      { label: 'Tables and Matrices (Excel)', url: relOutputUrl(jobId, xlsxPath), ext: 'xlsx' },
      { label: 'Presentation Summary (PPTX)', url: relOutputUrl(jobId, pptxPath), ext: 'pptx' },
      { label: 'Process Metadata (JSON)', url: relOutputUrl(jobId, metaPath), ext: 'json' },
    ];

    if (jobRecord && jobRecord.save) {
      try {
        jobRecord.status = 'done';
        jobRecord.outputFiles = outputFiles;
        jobRecord.completedAt = new Date();
        jobRecord.metadata = metadata;
        await jobRecord.save();
      } catch (error) {
        // Ignore non-fatal persistence issues.
      }
    }

    res.json({
      success: true,
      jobId,
      serviceName: SERVICE_04_NAME,
      provider: synthesis.provider,
      model: synthesis.model,
      preview: buildResponsePreview(report),
      outputFiles,
      report,
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

    res.status(500).json({ error: error.message || 'Service 04 report generation failed.' });
  }
});

router.get('/job/:jobId', async (req, res) => {
  const jobDir = path.join(OUTPUTS_DIR, req.params.jobId);
  const metaPath = path.join(jobDir, 'metadata.json');
  const reportPath = path.join(jobDir, 'report.json');

  if (fs.existsSync(metaPath)) {
    return res.json({
      metadata: safeReadJson(metaPath, {}),
      report: safeReadJson(reportPath, {}),
    });
  }

  if (Job) {
    try {
      const job = await Job.findOne({ jobId: req.params.jobId, service: 4 });
      if (!job) return res.status(404).json({ error: 'Job not found' });
      return res.json(job);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(404).json({ error: 'Job not found' });
});

module.exports = router;
