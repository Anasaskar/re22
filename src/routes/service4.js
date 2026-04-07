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

const { normalizeAiModel, getAiModelLabel } = require('../utils/aiModels');
const { generateStructuredJson } = require('../utils/aiTextProviders');
const { parseModelJsonObject } = require('../utils/structuredJson');

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

const STANDARD_LIBRARY_AR = {
  'UNESCO-HUL-2011': {
    title: 'توصية اليونسكو بشأن المشهد الحضري التاريخي',
    year: '2011',
    scope: 'السياق العمراني والقيم المتراكبة والإدارة المتكاملة للحفاظ.',
    note: 'يستخدم هذا المرجع عند ارتباط المشروع بالنطاق العمراني أو بالمشهد الحضري الأوسع.',
  },
  'WH-OG': {
    title: 'الإرشادات التشغيلية لتنفيذ اتفاقية التراث العالمي',
    year: 'الإصدار الحالي',
    scope: 'الأصالة والسلامة والحماية والإدارة والمتابعة.',
    note: 'يستخدم كإطار مرجعي لتقييم القيمة وأسس الحماية وخطط الإدارة.',
  },
  'VENICE-1964': {
    title: 'ميثاق فينيسيا للإيكروم والإيكوموس',
    year: '1964',
    scope: 'احترام النسيج التاريخي والأدلة الوثائقية والحد الأدنى الضروري من التدخل.',
    note: 'يفيد في ضبط حدود التدخل وأخلاقيات الحفاظ والترميم.',
  },
  'BURRA-2013': {
    title: 'ميثاق بورا',
    year: '2013',
    scope: 'التخطيط للحفاظ استناداً إلى القيمة الثقافية والاستخدام المتوافق.',
    note: 'يفيد عندما يتضمن المشروع إعادة استخدام تكيفية أو برنامجاً وظيفياً جديداً.',
  },
  'HC-DOC': {
    title: 'مسار التوثيق واعتماد الحفظ لدى هيئة التراث السعودية',
    year: 'خاص بالمشروع',
    scope: 'اكتمال التوثيق وتسجيل القيمة ومراجعة التدخلات وجاهزية ملف التقديم الرسمي.',
    note: 'يجب مواءمة الصياغة التنظيمية النهائية مع متطلبات المشروع والجهة المختصة.',
  },
  'SBC-ADAPT': {
    title: 'اشتراطات كود البناء السعودي ذات الصلة بإعادة الاستخدام التكيفي',
    year: 'خاص بالمشروع',
    scope: 'الإشغال وإمكانية الوصول والسلامة الإنشائية والحماية من الحريق وتنسيق الخدمات.',
    note: 'يستخدم كمرجع تنفيذي بالتوازي مع مراجعة متطلبات الحفظ والتراث.',
  },
  'SDG-11': {
    title: 'الهدف الحادي عشر من أهداف التنمية المستدامة',
    year: 'مستمر',
    scope: 'مدن ومجتمعات شاملة وقادرة على الصمود ومستدامة.',
    note: 'يفيد في تأطير القيمة الاجتماعية والمرونة والتجدد الحضري القائم على التراث.',
  },
  'CIRCULAR-REUSE': {
    title: 'ممارسات التأهيل الدائري وإدارة المواد',
    year: 'أفضل الممارسات',
    scope: 'الاحتفاظ بالمواد ومنطق التأهيل منخفض الكربون والتفكير في دورة الحياة.',
    note: 'يدعم استراتيجيات التدخل منخفض الأثر في الأصول التراثية.',
  },
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

const REPORT_TYPE_UI_LABELS_AR = {
  documentation: 'تقرير توثيق',
  academic: 'تقرير أكاديمي',
  feasibility: 'دراسة جدوى',
};

const REPORT_TYPE_LABELS_EN = {
  documentation: 'Documentation Report',
  academic: 'Academic Heritage Report',
  feasibility: 'Feasibility Study',
};

const REPORT_TYPE_INPUT_MAP = {
  documentation: 'documentation',
  'تقرير توثيق': 'documentation',
  academic: 'academic',
  'تقرير أكاديمي': 'academic',
  feasibility: 'feasibility',
  'دراسة جدوى': 'feasibility',
  rehabilitation: 'academic',
  'تقرير تأهيل': 'academic',
};

const REPORT_TYPE_LABELS_AR = {
  documentation: 'تقرير توثيق',
  rehabilitation: 'تقرير تأهيل',
  feasibility: 'دراسة جدوى',
};

const STATIC_LABELS = {
  english: {
    executiveSummary: 'Executive Summary',
    abstract: 'Abstract',
    standardsMatrix: 'Standards and Compliance Matrix',
    implementationRecommendations: 'Implementation Recommendations',
    references: 'References',
    location: 'Location',
    generated: 'Generated',
    heritageReport: 'Heritage Report',
    serviceName: SERVICE_04_NAME,
    notGeneratedSummary: 'Executive summary not generated.',
    notGeneratedAbstract: 'Abstract not generated.',
    noNarrative: 'No narrative generated for this section.',
    keywords: ['heritage conservation', 'adaptive reuse', 'rehabilitation strategy', 'heritage reporting'],
  },
  arabic: {
    executiveSummary: 'الملخص التنفيذي',
    abstract: 'المستخلص',
    standardsMatrix: 'مصفوفة المعايير والامتثال',
    implementationRecommendations: 'توصيات التنفيذ',
    references: 'المراجع',
    location: 'الموقع',
    generated: 'تاريخ الإنشاء',
    heritageReport: 'تقرير تراثي',
    serviceName: 'الخدمة 04: التقارير الأكاديمية التلقائية',
    notGeneratedSummary: 'لم يتم توليد الملخص التنفيذي.',
    notGeneratedAbstract: 'لم يتم توليد المستخلص.',
    noNarrative: 'لم يتم توليد محتوى لهذا القسم.',
    keywords: ['الحفاظ على التراث', 'إعادة الاستخدام التكيفي', 'استراتيجية التأهيل', 'التقارير التراثية'],
  },
  bilingual: {
    executiveSummary: 'الملخص التنفيذي / Executive Summary',
    abstract: 'المستخلص / Abstract',
    standardsMatrix: 'مصفوفة المعايير والامتثال / Standards and Compliance Matrix',
    implementationRecommendations: 'توصيات التنفيذ / Implementation Recommendations',
    references: 'المراجع / References',
    location: 'الموقع / Location',
    generated: 'تاريخ الإنشاء / Generated',
    heritageReport: 'تقرير تراثي / Heritage Report',
    serviceName: 'الخدمة 04: التقارير الأكاديمية التلقائية / Automated Academic Reporting',
    notGeneratedSummary: 'لم يتم توليد الملخص التنفيذي. / Executive summary not generated.',
    notGeneratedAbstract: 'لم يتم توليد المستخلص. / Abstract not generated.',
    noNarrative: 'لم يتم توليد محتوى لهذا القسم. / No narrative generated for this section.',
    keywords: ['الحفاظ على التراث', 'إعادة الاستخدام التكيفي', 'التقارير التراثية', 'heritage conservation'],
  },
};

const SECTION_TITLES = {
  english: {
    project_overview: 'Project Overview',
    historical_background: 'Historical Background',
    architectural_description: 'Architectural Description',
    condition_assessment: 'Condition Assessment',
    heritage_value: 'Heritage Value Assessment',
    urban_context: 'Geospatial and Urban Context',
    rehabilitation_strategy: 'Rehabilitation Strategy',
    proposed_interventions: 'Proposed Interventions',
    feasibility: 'Feasibility and Delivery Considerations',
    sustainability: 'Sustainability Considerations',
    standards_compliance: 'Standards and Compliance',
    implementation: 'Implementation Recommendations',
    conclusion: 'Conclusion',
  },
  arabic: {
    project_overview: 'نظرة عامة على المشروع',
    historical_background: 'الخلفية التاريخية',
    architectural_description: 'الوصف والتحليل المعماري',
    condition_assessment: 'تقييم الحالة الراهنة',
    heritage_value: 'تقييم القيمة التراثية',
    urban_context: 'السياق الجغرافي والعمراني',
    rehabilitation_strategy: 'استراتيجية التأهيل',
    proposed_interventions: 'التدخلات المقترحة',
    feasibility: 'الجدوى واعتبارات التنفيذ',
    sustainability: 'اعتبارات الاستدامة',
    standards_compliance: 'المعايير والامتثال',
    implementation: 'توصيات التنفيذ',
    conclusion: 'الخاتمة',
  },
  bilingual: {
    project_overview: 'نظرة عامة على المشروع / Project Overview',
    historical_background: 'الخلفية التاريخية / Historical Background',
    architectural_description: 'الوصف والتحليل المعماري / Architectural Description',
    condition_assessment: 'تقييم الحالة الراهنة / Condition Assessment',
    heritage_value: 'تقييم القيمة التراثية / Heritage Value Assessment',
    urban_context: 'السياق الجغرافي والعمراني / Geospatial and Urban Context',
    rehabilitation_strategy: 'استراتيجية التأهيل / Rehabilitation Strategy',
    proposed_interventions: 'التدخلات المقترحة / Proposed Interventions',
    feasibility: 'الجدوى واعتبارات التنفيذ / Feasibility and Delivery Considerations',
    sustainability: 'اعتبارات الاستدامة / Sustainability Considerations',
    standards_compliance: 'المعايير والامتثال / Standards and Compliance',
    implementation: 'توصيات التنفيذ / Implementation Recommendations',
    conclusion: 'الخاتمة / Conclusion',
  },
};

const REPORT_STRUCTURE_BY_TYPE = {
  documentation: [
    'project_overview',
    'historical_background',
    'architectural_description',
    'condition_assessment',
    'heritage_value',
    'urban_context',
    'documentation_scope',
    'standards_compliance',
    'conservation_notes',
    'conclusion',
  ],
  academic: [
    'research_framework',
    'methodology',
    'historical_background',
    'architectural_description',
    'condition_assessment',
    'heritage_value',
    'urban_context',
    'comparative_discussion',
    'standards_compliance',
    'conclusion',
  ],
  feasibility: [
    'project_overview',
    'heritage_value',
    'technical_feasibility',
    'operational_feasibility',
    'financial_feasibility',
    'implementation_strategy',
    'risk_assessment',
    'standards_compliance',
    'sustainability',
    'conclusion',
  ],
};

const REPORT_TYPE_SECTION_TITLES = {
  english: {
    research_framework: 'Research Framework and Questions',
    methodology: 'Methodology and Source Critique',
    documentation_scope: 'Documentation Scope and Evidence Base',
    conservation_notes: 'Documentation Findings and Conservation Notes',
    comparative_discussion: 'Research Discussion',
    technical_feasibility: 'Technical Feasibility Analysis',
    operational_feasibility: 'Operational Feasibility Analysis',
    financial_feasibility: 'Financial and Resource Feasibility',
    implementation_strategy: 'Implementation Strategy',
    risk_assessment: 'Risk Analysis',
  },
  arabic: {
    research_framework: 'الإطار البحثي وأسئلة الدراسة',
    methodology: 'المنهجية ونقد المصادر',
    documentation_scope: 'نطاق التوثيق وقاعدة الأدلة',
    conservation_notes: 'نتائج التوثيق والملاحظات الحفظية',
    comparative_discussion: 'المناقشة البحثية',
    technical_feasibility: 'الجدوى الفنية',
    operational_feasibility: 'الجدوى التشغيلية',
    financial_feasibility: 'الجدوى المالية والموارد',
    implementation_strategy: 'استراتيجية التنفيذ',
    risk_assessment: 'تحليل المخاطر',
  },
  bilingual: {
    research_framework: 'الإطار البحثي وأسئلة الدراسة / Research Framework and Questions',
    methodology: 'المنهجية ونقد المصادر / Methodology and Source Critique',
    documentation_scope: 'نطاق التوثيق وقاعدة الأدلة / Documentation Scope and Evidence Base',
    conservation_notes: 'نتائج التوثيق والملاحظات الحفظية / Documentation Findings and Conservation Notes',
    comparative_discussion: 'المناقشة البحثية / Research Discussion',
    technical_feasibility: 'الجدوى الفنية / Technical Feasibility Analysis',
    operational_feasibility: 'الجدوى التشغيلية / Operational Feasibility Analysis',
    financial_feasibility: 'الجدوى المالية والموارد / Financial and Resource Feasibility',
    implementation_strategy: 'استراتيجية التنفيذ / Implementation Strategy',
    risk_assessment: 'تحليل المخاطر / Risk Analysis',
  },
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

function getLanguageKey(language) {
  if (language === 'arabic' || language === 'bilingual') return language;
  return 'english';
}

function getStaticLabels(language) {
  return STATIC_LABELS[getLanguageKey(language)] || STATIC_LABELS.english;
}

function getSectionTitle(sectionId, language) {
  const key = getLanguageKey(language);
  return REPORT_TYPE_SECTION_TITLES[key]?.[sectionId]
    || SECTION_TITLES[key]?.[sectionId]
    || REPORT_TYPE_SECTION_TITLES.english[sectionId]
    || SECTION_TITLES.english[sectionId]
    || sectionId;
}

function normalizeReportType(value = 'documentation') {
  const normalized = normalizeText(value, 'documentation');
  return REPORT_TYPE_INPUT_MAP[normalized] || 'documentation';
}

function getReportTypeUiLabel(type = 'documentation') {
  return REPORT_TYPE_UI_LABELS_AR[normalizeReportType(type)] || REPORT_TYPE_UI_LABELS_AR.documentation;
}

function getReportTypeLabelLocalized(type, language) {
  if (language === 'arabic') return REPORT_TYPE_LABELS_AR[type] || 'تقرير تراثي';
  if (language === 'bilingual') {
    return `${REPORT_TYPE_LABELS_AR[type] || 'تقرير تراثي'} / ${REPORT_TYPE_LABELS[type] || 'Heritage Report'}`;
  }
  return REPORT_TYPE_LABELS[type] || 'Heritage Report';
}

function localizeTemplateText(englishText, arabicText, language) {
  if (language === 'arabic') return arabicText;
  if (language === 'bilingual') return `${arabicText}\n\n${englishText}`;
  return englishText;
}

function getReportTypeLabelLocalized(type, language) {
  const normalizedType = normalizeReportType(type);
  if (language === 'arabic') return REPORT_TYPE_UI_LABELS_AR[normalizedType] || 'تقرير تراثي';
  if (language === 'bilingual') {
    return `${REPORT_TYPE_UI_LABELS_AR[normalizedType] || 'تقرير تراثي'} / ${REPORT_TYPE_LABELS_EN[normalizedType] || 'Heritage Report'}`;
  }
  return REPORT_TYPE_LABELS_EN[normalizedType] || 'Heritage Report';
}

function getReportStructure(type = 'documentation') {
  return REPORT_STRUCTURE_BY_TYPE[normalizeReportType(type)] || REPORT_STRUCTURE_BY_TYPE.documentation;
}

function getReportTypePromptProfile(type = 'documentation', language = 'english') {
  const normalizedType = normalizeReportType(type);

  const profiles = {
    documentation: {
      english: {
        objective: 'Produce a true documentation report centered on historical, architectural, and heritage recording.',
        tone: 'documentation-led, descriptive, evidence-based, and conservation-aware',
        emphasis: 'Prioritize documentary evidence, fabric description, condition recording, heritage significance, and documentation limitations.',
      },
      arabic: {
        objective: 'أعد تقرير توثيق حقيقي يركز على التوثيق التاريخي والمعماري والتراثي.',
        tone: 'صياغة توثيقية وصفية قائمة على الأدلة وحساسة لقيم الحفظ',
        emphasis: 'أعط الأولوية للأدلة الوثائقية ووصف النسيج المعماري وتسجيل الحالة والقيمة التراثية وحدود المعلومات المتاحة.',
      },
    },
    academic: {
      english: {
        objective: 'Produce a true academic heritage report with a research-oriented structure and writing style.',
        tone: 'scholarly, analytical, research-oriented, and thesis-grade',
        emphasis: 'Frame the report as an academic study with research questions, methodology, analytical discussion, and evidence-based conclusions.',
      },
      arabic: {
        objective: 'أعد تقريراً أكاديمياً تراثياً حقيقياً ببنية بحثية وأسلوب كتابة أكاديمي.',
        tone: 'صياغة بحثية تحليلية رصينة بمستوى أكاديمي',
        emphasis: 'صغ التقرير كدراسة أكاديمية تتضمن إطاراً بحثياً ومنهجية ومناقشة تحليلية وخلاصات قائمة على الأدلة.',
      },
    },
    feasibility: {
      english: {
        objective: 'Produce a true feasibility study.',
        tone: 'decision-oriented, analytical, viability-focused, and implementation-aware',
        emphasis: 'Explicitly evaluate technical, operational, financial, implementation, and risk viability. State whether the project appears viable and under what conditions.',
      },
      arabic: {
        objective: 'أعد دراسة جدوى حقيقية.',
        tone: 'صياغة تحليلية موجهة لاتخاذ القرار وتركز على قابلية التنفيذ والجدوى',
        emphasis: 'قيّم بوضوح الجدوى الفنية والتشغيلية والمالية والتنفيذية وتحليل المخاطر، واذكر مدى قابلية المشروع للتنفيذ وشروط ذلك.',
      },
    },
  };

  const languageKey = language === 'arabic' ? 'arabic' : 'english';
  return profiles[normalizedType][languageKey];
}

function containsArabic(value = '') {
  return /[\u0600-\u06FF]/.test(String(value || ''));
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

function countArabicChars(value = '') {
  const matches = String(value || '').match(/[\u0600-\u06FF]/g);
  return matches ? matches.length : 0;
}

function countLatinChars(value = '') {
  const matches = String(value || '').match(/[A-Za-z]/g);
  return matches ? matches.length : 0;
}

function isMostlyArabic(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const arabicChars = countArabicChars(text);
  const latinChars = countLatinChars(text);
  return arabicChars >= 3 && arabicChars > (latinChars * 1.5);
}

function shouldFallbackEnglishText(value = '', options = {}) {
  const text = String(value || '').trim();
  if (!text || !containsArabic(text)) return false;

  const latinChars = countLatinChars(text);
  return Boolean(options.strictEnglish) || latinChars === 0 || isMostlyArabic(text);
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

function sanitizeValueForLanguage(value = '', language = 'english', englishFallback = 'Not provided', options = {}) {
  const text = normalizeText(value, englishFallback);
  if (!text) return englishFallback;
  if (language === 'english' && shouldFallbackEnglishText(text, options)) return englishFallback;
  if (language === 'arabic' && shouldFallbackArabicText(text, options)) return englishFallback;
  return text;
}

function sanitizeMultilineForLanguage(value = '', language = 'english', englishFallback = 'Not provided', options = {}) {
  const text = normalizeMultiline(value, englishFallback);
  if (!text) return englishFallback;
  if (language === 'english' && shouldFallbackEnglishText(text, options)) return englishFallback;
  if (language === 'arabic' && shouldFallbackArabicText(text, options)) return englishFallback;
  return text;
}

function sanitizeArrayForLanguage(values = [], language = 'english', fallback = []) {
  const normalized = Array.isArray(values)
    ? values.map(value => normalizeText(value)).filter(Boolean)
    : [];

  if (language === 'arabic') {
    const sanitized = normalized.filter(value => !shouldFallbackArabicText(value));
    return sanitized.length ? sanitized : fallback;
  }

  if (language !== 'english') return normalized;

  const sanitized = normalized.filter(value => !containsArabic(value));
  return sanitized.length ? sanitized : fallback;
}

function translateKnownArabicFragments(value = '') {
  let text = String(value || '');
  if (!text) return text;

  const replacements = [
    [/The building is a significant example of Hijazi architecture, showcasing traditional craftsmanship and cultural heritage\.?/gi, 'تمثل المنشأة مثالاً بارزاً على العمارة الحجازية بما تعكسه من حرف تقليدية وقيمة ثقافية.'],
    [/Wooden latticework\s*\(mashrabiya\)/gi, 'الرواشين الخشبية'],
    [/Ornate wooden balconies/gi, 'الشرفات الخشبية المزخرفة'],
    [/Stucco and stone facade/gi, 'الواجهات الحجرية والجصية'],
    [/Rectangular window openings/gi, 'فتحات النوافذ المستطيلة'],
    [/Decorative cornices/gi, 'الكرانيش الزخرفية'],
    [/\bHijazi\b/gi, 'حجازي'],
    [/Not provided\.?/gi, 'غير متوفر'],
    [/Date not provided\.?/gi, 'التاريخ غير متوفر'],
    [/heritage architectural language/gi, 'طراز معماري تراثي'],
    [/adaptive reuse program/gi, 'برنامج إعادة استخدام تكيفي'],
    [/not fully classified/gi, 'غير مصنف بدقة'],
    [/no specific features recorded/gi, 'لم يتم تسجيل سمات محددة'],
    [/the surrounding district/gi, 'النطاق العمراني المحيط'],
  ];

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

function sanitizeArabicValue(value = '', fallback = 'غير متوفر') {
  return sanitizeValueForLanguage(
    translateKnownArabicFragments(value),
    'arabic',
    fallback,
    { strictArabic: true },
  );
}

function sanitizeArabicMultiline(value = '', fallback = 'غير متوفر') {
  return sanitizeMultilineForLanguage(
    translateKnownArabicFragments(value),
    'arabic',
    fallback,
    { strictArabic: true },
  );
}

function sanitizeArabicArray(values = [], fallback = []) {
  const translated = Array.isArray(values) ? values.map(translateKnownArabicFragments) : [];
  return sanitizeArrayForLanguage(translated, 'arabic', fallback);
}

function neutralizeServiceMentions(value = '', language = 'english') {
  let text = String(value || '');
  if (!text) return text;

  if (language === 'english' || language === 'bilingual') {
    const englishReplacements = [
      [/linked heritage-service outputs/gi, 'supporting reference material'],
      [/prior service outputs/gi, 'supporting analyses'],
      [/linked outputs from Services 01, 02, and 03/gi, 'available reference materials and prior analyses'],
      [/linked service outputs/gi, 'supporting analytical material'],
      [/Service 02 identified/gi, 'Available architectural analysis indicates'],
      [/No Service 02 visualization metadata was linked/gi, 'No supplementary architectural analysis was available'],
      [/Service 02 further characterized the heritage value as/gi, 'Additional architectural analysis characterizes the heritage value as'],
      [/Service 03 contextualized the project within/gi, 'The project is situated within'],
      [/The linked urban analysis describes the setting as/gi, 'Available urban analysis describes the setting as'],
      [/No Service 03 dataset was linked/gi, 'No supplementary urban dataset was available'],
      [/Service 01 contributed ([0-9]+) visual restoration output\(s\), which support interpretation of deteriorated or incomplete visual evidence and provide a comparative basis for documenting lost or obscured details\./gi, '$1 visual reference output(s) were available to support interpretation of deteriorated or incomplete visual evidence and to provide a comparative basis for documenting lost or obscured details.'],
      [/No Service 01 restoration package was linked/gi, 'No supplementary visual reference package was available'],
      [/Comparative visual outputs from Service 01/gi, 'Comparative visual reference outputs'],
      [/Architectural visualization sheets from Service 02/gi, 'Architectural visualization sheets'],
      [/Geospatial maps and urban context outputs from Service 03/gi, 'Geospatial maps and urban context outputs'],
      [/The linked service outputs provide useful visual, architectural, and contextual support/gi, 'The available visual, architectural, and contextual materials provide useful support'],
    ];

    for (const [pattern, replacement] of englishReplacements) {
      text = text.replace(pattern, replacement);
    }
  }

  if (language === 'arabic' || language === 'bilingual') {
    const arabicReplacements = [
      [/المخرجات المرتبطة من الخدمات 01 و02 و03/g, 'المواد المرجعية والتحليلات المتوفرة'],
      [/مخرجات الخدمات السابقة/g, 'التحليلات المساندة'],
      [/الخدمات التراثية/g, 'المواد المرجعية المساندة'],
      [/وقد أشارت الخدمة 02 إلى أن النمط الأقرب هو/g, 'وتشير القراءة المعمارية المتاحة إلى أن النمط الأقرب هو'],
      [/لم يتم ربط مخرجات من الخدمة 02، ولذلك/g, 'لم تتوفر قراءة معمارية مساندة، ولذلك'],
      [/وقد دعمت الخدمة 02 هذا التقييم ببيان أن القيمة التراثية تتمثل في:/g, 'كما دعمت القراءة المعمارية الإضافية هذا التقييم ببيان أن القيمة التراثية تتمثل في:'],
      [/وضعت الخدمة 03 المشروع ضمن نطاق/g, 'يقع المشروع ضمن نطاق'],
      [/ولم تُربط بيانات من الخدمة 03، لذلك/g, 'ولم تتوفر بيانات عمرانية إضافية، لذلك'],
      [/لم يتم ربط حزمة ترميم بصري من الخدمة 01، ولذلك/g, 'لم تتوفر حزمة مرجعية بصرية إضافية، ولذلك'],
      [/مخرجات المقارنة البصرية من الخدمة 01/g, 'مخرجات مرجعية للمقارنة البصرية'],
      [/لوحات التصور المعماري من الخدمة 02/g, 'لوحات التصور المعماري'],
      [/خرائط ومخرجات السياق الجغرافي والعمراني من الخدمة 03/g, 'خرائط ومخرجات السياق الجغرافي والعمراني'],
      [/مخرجات الخدمات المرتبطة/g, 'المواد البصرية والمعمارية والسياقية المتاحة'],
    ];

    for (const [pattern, replacement] of arabicReplacements) {
      text = text.replace(pattern, replacement);
    }
  }

  return text;
}

function localizedProjectView(project = {}, language = 'english') {
  if (language === 'arabic') {
    return {
      ...project,
      buildingName: sanitizeArabicValue(project.buildingName, 'أصل تراثي'),
      location: sanitizeArabicValue(project.location, 'الموقع غير محدد'),
      approximateDate: sanitizeArabicValue(project.approximateDate, 'التاريخ غير متوفر'),
      currentCondition: sanitizeArabicMultiline(project.currentCondition, 'الحالة غير موضحة'),
      historicalBackground: sanitizeArabicMultiline(project.historicalBackground, 'لم تتوفر خلفية تاريخية مفصلة.'),
      architecturalStyle: sanitizeArabicValue(project.architecturalStyle, 'طراز تراثي غير محدد'),
      heritageSignificance: sanitizeArabicMultiline(project.heritageSignificance, 'لم يرد وصف تفصيلي للقيمة التراثية.'),
      conditionAndDamage: sanitizeArabicMultiline(project.conditionAndDamage, 'لم ترد ملاحظات تفصيلية عن الحالة والأضرار.'),
      rehabilitationStrategy: sanitizeArabicMultiline(project.rehabilitationStrategy, 'لم ترد استراتيجية تأهيل تفصيلية.'),
      targetFunction: sanitizeArabicValue(project.targetFunction, 'غير محدد'),
      adaptiveReuseConcept: sanitizeArabicMultiline(project.adaptiveReuseConcept, 'لم يرد تصور تفصيلي لإعادة الاستخدام.'),
      geographicContext: sanitizeArabicMultiline(project.geographicContext, 'لم يرد وصف تفصيلي للسياق الجغرافي والعمراني.'),
      notes: sanitizeArabicMultiline(project.notes, ''),
    };
  }

  if (language !== 'english') return { ...project };

  return {
    ...project,
    buildingName: sanitizeValueForLanguage(project.buildingName, language, 'Historic heritage asset', { strictEnglish: true }),
    location: sanitizeValueForLanguage(project.location, language, 'Documented site', { strictEnglish: true }),
    approximateDate: sanitizeValueForLanguage(project.approximateDate, language, 'Date not provided', { strictEnglish: true }),
    currentCondition: sanitizeMultilineForLanguage(project.currentCondition, language, 'Condition not provided', { strictEnglish: true }),
    historicalBackground: sanitizeMultilineForLanguage(project.historicalBackground, language, 'Historical background was supplied in Arabic source notes and should be translated into English summary form.', { strictEnglish: true }),
    architecturalStyle: sanitizeValueForLanguage(project.architecturalStyle, language, 'Architectural style not fully specified', { strictEnglish: true }),
    heritageSignificance: sanitizeMultilineForLanguage(project.heritageSignificance, language, 'Heritage significance was supplied in Arabic source notes and should be summarized in English.', { strictEnglish: true }),
    conditionAndDamage: sanitizeMultilineForLanguage(project.conditionAndDamage, language, 'Condition observations were supplied in Arabic source notes and should be summarized in English.', { strictEnglish: true }),
    rehabilitationStrategy: sanitizeMultilineForLanguage(project.rehabilitationStrategy, language, 'Rehabilitation strategy was supplied in Arabic source notes and should be summarized in English.', { strictEnglish: true }),
    targetFunction: sanitizeValueForLanguage(project.targetFunction, language, 'Not provided', { strictEnglish: true }),
    adaptiveReuseConcept: sanitizeMultilineForLanguage(project.adaptiveReuseConcept, language, 'Adaptive reuse concept was supplied in Arabic source notes and should be summarized in English.', { strictEnglish: true }),
    geographicContext: sanitizeMultilineForLanguage(project.geographicContext, language, 'Geographic context was supplied in Arabic source notes and should be summarized in English.', { strictEnglish: true }),
    notes: sanitizeMultilineForLanguage(project.notes, language, '', { strictEnglish: true }),
  };
}

function localizedService2View(service2 = null, language = 'english') {
  if (!service2) return service2;

  if (language === 'arabic') {
    const styleAnalysis = service2.styleAnalysis || {};
    const fallbackStyle = sanitizeArabicValue(service2.style, 'طراز تراثي');

    return {
      ...service2,
      style: fallbackStyle,
      buildingType: sanitizeArabicValue(service2.buildingType, 'وظيفة تأهيلية مقترحة'),
      styleAnalysis: {
        ...styleAnalysis,
        detectedStyle: sanitizeArabicValue(styleAnalysis.detectedStyle, fallbackStyle),
        elements: sanitizeArabicArray(styleAnalysis.elements, ['عناصر معمارية تراثية مميزة']),
        heritageValue: sanitizeArabicMultiline(styleAnalysis.heritageValue, 'تعكس العناصر المعمارية المتاحة قيمة تراثية ومعمارية للمبنى.'),
        notes: sanitizeArabicMultiline(styleAnalysis.notes, ''),
        reuseGuidance: sanitizeArabicMultiline(styleAnalysis.reuseGuidance, ''),
      },
    };
  }

  if (language !== 'english') return service2;

  const styleAnalysis = service2.styleAnalysis || {};
  const fallbackStyle = sanitizeValueForLanguage(service2.style, language, 'heritage architectural language', { strictEnglish: true });

  return {
    ...service2,
    style: fallbackStyle,
    buildingType: sanitizeValueForLanguage(service2.buildingType, language, 'adaptive reuse program', { strictEnglish: true }),
    styleAnalysis: {
      ...styleAnalysis,
      detectedStyle: sanitizeValueForLanguage(styleAnalysis.detectedStyle, language, fallbackStyle, { strictEnglish: true }),
      elements: sanitizeArrayForLanguage(styleAnalysis.elements, language, ['heritage-defining elements were not enumerated']),
      heritageValue: sanitizeMultilineForLanguage(styleAnalysis.heritageValue, language, '', { strictEnglish: true }),
      notes: sanitizeMultilineForLanguage(styleAnalysis.notes, language, '', { strictEnglish: true }),
      reuseGuidance: sanitizeMultilineForLanguage(styleAnalysis.reuseGuidance, language, '', { strictEnglish: true }),
    },
  };
}

function localizedService3View(service3 = null, language = 'english') {
  if (!service3) return service3;

  if (language === 'arabic') {
    const urbanAnalysis = service3.urbanAnalysis || {};

    return {
      ...service3,
      districtName: sanitizeArabicValue(service3.districtName, 'النطاق العمراني المحيط'),
      city: sanitizeArabicValue(service3.city, ''),
      urbanAnalysis: {
        ...urbanAnalysis,
        detectedStyle: sanitizeArabicValue(urbanAnalysis.detectedStyle, ''),
        urbanPattern: sanitizeArabicValue(urbanAnalysis.urbanPattern, 'نسيج عمراني تراثي'),
        keyFeatures: sanitizeArabicArray(urbanAnalysis.keyFeatures, ['سمات عمرانية تراثية']),
        heritageValue: sanitizeArabicMultiline(urbanAnalysis.heritageValue, ''),
        restorationNotes: sanitizeArabicMultiline(urbanAnalysis.restorationNotes, ''),
      },
    };
  }

  if (language !== 'english') return service3;

  const urbanAnalysis = service3.urbanAnalysis || {};

  return {
    ...service3,
    districtName: sanitizeValueForLanguage(service3.districtName, language, 'the surrounding district', { strictEnglish: true }),
    city: sanitizeValueForLanguage(service3.city, language, '', { strictEnglish: true }),
    urbanAnalysis: {
      ...urbanAnalysis,
      detectedStyle: sanitizeValueForLanguage(urbanAnalysis.detectedStyle, language, '', { strictEnglish: true }),
      urbanPattern: sanitizeValueForLanguage(urbanAnalysis.urbanPattern, language, 'not fully classified', { strictEnglish: true }),
      keyFeatures: sanitizeArrayForLanguage(urbanAnalysis.keyFeatures, language, ['no specific features recorded']),
      heritageValue: sanitizeMultilineForLanguage(urbanAnalysis.heritageValue, language, '', { strictEnglish: true }),
      restorationNotes: sanitizeMultilineForLanguage(urbanAnalysis.restorationNotes, language, '', { strictEnglish: true }),
    },
  };
}

function localizedLinkedServicesView(linkedServices = {}, language = 'english') {
  if (language !== 'english' && language !== 'arabic') return { ...linkedServices };

  const localizeJob = job => {
    if (!job) return job;
    if (job.service === 2) return localizedService2View(job, language);
    if (job.service === 3) return localizedService3View(job, language);
    return { ...job };
  };

  return {
    ...linkedServices,
    service1: linkedServices.service1 ? { ...linkedServices.service1 } : null,
    service2: localizedService2View(linkedServices.service2, language),
    service3: localizedService3View(linkedServices.service3, language),
    all: Array.isArray(linkedServices.all) ? linkedServices.all.map(localizeJob) : linkedServices.all,
  };
}

function localizeStandardItem(item = {}, language = 'english') {
  if (language === 'arabic') {
    const localized = STANDARD_LIBRARY_AR[item.code];
    if (localized) return { ...item, ...localized };
    return {
      ...item,
      title: sanitizeArabicValue(item.title, 'مرجع معياري'),
      year: sanitizeArabicValue(item.year, 'غير محدد'),
      scope: sanitizeArabicMultiline(item.scope, 'وصف المعيار غير متوفر.'),
      note: sanitizeArabicMultiline(item.note, 'ملاحظة تنظيمية غير متوفرة.'),
    };
  }

  return { ...item };
}

function localizedContextView(context = {}) {
  const language = normalizeText(context.report?.language, 'english');
  return {
    ...context,
    project: localizedProjectView(context.project || {}, language),
    linkedServices: localizedLinkedServicesView(context.linkedServices || {}, language),
  };
}

function collectReportText(report = {}) {
  return [
    report.title,
    report.executiveSummary,
    report.abstract,
    ...(Array.isArray(report.keywords) ? report.keywords : []),
    ...(Array.isArray(report.sections) ? report.sections.flatMap(section => [section.title, section.body, ...(section.keyPoints || [])]) : []),
    ...(Array.isArray(report.standardsChecklist) ? report.standardsChecklist.flatMap(item => [item.framework, item.principle, item.application, item.status]) : []),
    ...(Array.isArray(report.sustainabilityMatrix) ? report.sustainabilityMatrix.flatMap(item => [item.dimension, item.consideration, item.projectResponse]) : []),
    ...(Array.isArray(report.implementationRecommendations) ? report.implementationRecommendations.flatMap(item => [item.phase, item.priority, item.recommendation, item.deliverable]) : []),
    ...(Array.isArray(report.references) ? report.references.flatMap(item => [item.title, item.year, item.note]) : []),
    ...(Array.isArray(report.appendixSuggestions) ? report.appendixSuggestions : []),
  ].filter(Boolean).join('\n');
}

function reportContainsArabicNarrative(report = {}) {
  const narrativeParts = [
    report.title,
    report.executiveSummary,
    report.abstract,
    ...(Array.isArray(report.sections)
      ? report.sections.flatMap(section => [section.title, section.body, ...(section.keyPoints || [])])
      : []),
    ...(Array.isArray(report.implementationRecommendations)
      ? report.implementationRecommendations.flatMap(item => [item.phase, item.recommendation, item.deliverable])
      : []),
  ].filter(Boolean);

  return narrativeParts.some(part => /[\u0600-\u06FF]{2,}/.test(String(part || '')));
}

function reportContainsLatinLeak(report = {}) {
  const narrativeParts = [
    report.title,
    report.executiveSummary,
    report.abstract,
    ...(Array.isArray(report.sections)
      ? report.sections.flatMap(section => [section.title, section.body, ...(section.keyPoints || [])])
      : []),
    ...(Array.isArray(report.implementationRecommendations)
      ? report.implementationRecommendations.flatMap(item => [item.phase, item.recommendation, item.deliverable])
      : []),
  ].filter(Boolean);

  return narrativeParts.some(part => shouldFallbackArabicText(part));
}

function reportMatchesRequestedLanguage(report, language = 'english') {
  const text = collectReportText(report);
  const arabicChars = countArabicChars(text);
  const latinChars = countLatinChars(text);

  if (language === 'arabic') {
    return arabicChars >= 120
      && arabicChars >= (latinChars * 1.2)
      && !reportContainsLatinLeak(report);
  }

  if (language === 'english') {
    return latinChars >= 120
      && arabicChars <= Math.max(6, Math.floor(latinChars * 0.01))
      && !reportContainsArabicNarrative(report);
  }

  if (language === 'bilingual') {
    return arabicChars >= 80 && latinChars >= 80;
  }

  return true;
}

function buildTemplateSectionBodies(context, service1, service2, service3) {
  const reportType = normalizeReportType(context.report.type);
  if (reportType === 'documentation') {
    return buildDocumentationTemplateSectionBodies(context, service1, service2, service3);
  }
  if (reportType === 'academic') {
    return buildAcademicTemplateSectionBodies(context, service1, service2, service3);
  }
  if (reportType === 'feasibility') {
    return buildFeasibilityTemplateSectionBodies(context, service1, service2, service3);
  }

  const english = {
    project_overview: `This report documents the heritage asset "${context.project.buildingName}" located in ${context.project.location}. The reporting brief is framed as a ${REPORT_TYPE_LABELS[context.report.type] || 'heritage report'} prepared in ${REPORT_MODE_LABELS[context.report.mode] || 'professional'} mode. The report synthesizes project metadata together with available reference materials and prior analyses to support documentation, planning, and decision-making.`,
    historical_background: `Available background information indicates the asset dates to ${context.project.approximateDate}. The supplied historical background states: ${context.project.historicalBackground} The historical record should be treated as a working basis for documentation and may require archival verification where precise dates, phases of construction, or ownership history are still incomplete.`,
    architectural_description: `The architectural character is currently described as ${context.project.architecturalStyle || 'not fully specified'}. ${service2 ? `Available architectural analysis indicates ${service2.styleAnalysis.detectedStyle || service2.style || 'a heritage architectural language'} and highlights the following defining elements: ${(service2.styleAnalysis.elements || []).join(', ') || 'heritage-defining elements were not enumerated'}.` : 'No supplementary architectural analysis was available, so this section relies primarily on the user-provided description.'} The description should be read as a synthesis of project inputs and supporting analytical material rather than a substitute for measured survey documentation.`,
    condition_assessment: `The current condition is described as ${context.project.currentCondition}. Observed damage and condition notes include: ${context.project.conditionAndDamage} ${service1 ? `${service1.imageCount} visual reference output(s) were available to support interpretation of deteriorated or incomplete visual evidence and to provide a comparative basis for documenting lost or obscured details.` : 'No supplementary visual reference package was available, so condition interpretation remains limited to the submitted description and attachments.'}`,
    heritage_value: `The heritage significance provided for the asset is summarized as follows: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `Additional architectural analysis characterizes the heritage value as ${service2.styleAnalysis.heritageValue}.` : ''} Heritage value should continue to guide the hierarchy of intervention so that the most significant materials, spatial relationships, and architectural attributes receive the strongest protection.`,
    urban_context: `${service3 ? `The project is situated within ${service3.districtName || 'its wider district'}${service3.city ? `, ${service3.city}` : ''}. Available urban analysis describes the setting as ${service3.urbanAnalysis.urbanPattern || 'not fully classified'}, with key features including ${(service3.urbanAnalysis.keyFeatures || []).join(', ') || 'no specific features recorded'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `The geographic and urban context supplied for the asset is: ${context.project.geographicContext} No supplementary urban dataset was available, so district-scale interpretation remains dependent on the submitted contextual note rather than formal geospatial analysis.`}`,
    rehabilitation_strategy: `The proposed rehabilitation strategy is articulated as follows: ${context.project.rehabilitationStrategy} The target function is ${context.project.targetFunction}, and the adaptive reuse concept is described as: ${context.project.adaptiveReuseConcept} The strategy should therefore balance conservation of character-defining attributes with the technical requirements of reuse, accessibility, safety, and ongoing maintenance.`,
    proposed_interventions: `Based on the supplied evidence, the intervention logic should prioritize documentation, stabilization, repair of damaged fabric, selective rehabilitation of service systems, and reuse-compatible upgrades. Intervention design should remain distinguishable in documentation while being materially and visually compatible with the historic character of the building. Additional specialist assessment is recommended for structure, materials conservation, building services, and code compliance before implementation.`,
    feasibility: `Feasibility depends on technical condition, reuse compatibility, regulatory acceptance, and budget/operations planning. The project should therefore be phased through documentation, investigation, urgent stabilization, design development, approvals, and implementation. A more detailed feasibility stage may also require cost estimation, stakeholder mapping, phasing analysis, and operational planning for the proposed target function.`,
    sustainability: `Sustainability in this project should be understood across environmental, social, and economic dimensions. Environmental value arises from retention of embodied carbon and material reuse; social value arises from continuity of heritage identity and public interpretation; economic value arises from adaptive reuse and long-term functionality. Sustainability performance should be strengthened through low-impact repair, durable material choices, maintenance planning, and climate-responsive retrofit decisions.`,
    standards_compliance: `The project should be interpreted against the selected standards profile while recognizing that formal compliance still requires project-specific review. The embedded framework set emphasizes cultural significance, minimum necessary intervention, authenticity, integrity, documentation quality, and compatible reuse. Where local approvals are required, the report should be treated as a submission-support document rather than a substitute for official regulatory review.`,
    implementation: `Implementation should proceed in phases: documentation and verification, specialist investigation, urgent stabilization, detailed design, approvals, rehabilitation works, and monitoring/maintenance. Early coordination should focus on the most vulnerable fabric and on clarifying which interventions are reversible, which are repair-based, and which require carefully justified adaptation for the new use.`,
    conclusion: `In conclusion, the project demonstrates clear potential for structured heritage rehabilitation provided that the intervention process remains evidence-led and significance-based. The available visual, architectural, and contextual materials provide useful support, but final design and approval stages should continue to verify condition, regulation, and constructability in detail.`,
  };

  const arabic = {
    project_overview: `يوثق هذا التقرير الأصل التراثي "${context.project.buildingName}" الواقع في ${context.project.location}. وقد صيغت المهمة باعتبارها ${REPORT_TYPE_LABELS_AR[context.report.type] || 'تقريراً تراثياً'} وفق ${context.report.mode === 'academic' ? 'أسلوب أكاديمي تحليلي' : context.report.mode === 'government' ? 'صياغة رسمية مهيأة للتقديم' : 'صياغة مهنية تنفيذية'}. ويعتمد التقرير على بيانات المشروع المتاحة مع دمج المواد المرجعية والتحليلات المتوفرة لدعم التوثيق والتخطيط واتخاذ القرار.`,
    historical_background: `تشير المعلومات المتاحة إلى أن الأصل يعود تقريباً إلى ${context.project.approximateDate}. وتتضمن الخلفية التاريخية المقدمة ما يلي: ${context.project.historicalBackground} وينبغي التعامل مع هذه المادة بوصفها أساساً أولياً للتوثيق إلى حين استكمال التحقق الأرشيفي والتاريخي عند الحاجة، خاصة فيما يتعلق بالتأريخ الدقيق ومراحل الإنشاء والتحولات اللاحقة.`,
    architectural_description: `يوصف الطابع المعماري الحالي بأنه ${context.project.architecturalStyle || 'غير محدد بشكل كافٍ'}. ${service2 ? `وتشير القراءة المعمارية المتاحة إلى أن النمط الأقرب هو ${service2.styleAnalysis.detectedStyle || service2.style || 'طراز تراثي'}، مع إبراز العناصر المميزة التالية: ${(service2.styleAnalysis.elements || []).join('، ') || 'لم يتم حصر العناصر المميزة بشكل مفصل'}.` : 'لم تتوفر قراءة معمارية مساندة، ولذلك يستند هذا القسم أساساً إلى المدخلات النصية والملفات المرفقة.'} ويجب قراءة هذا الوصف باعتباره تركيباً تحليلياً أولياً لا يغني عن الرفع المعماري الميداني أو التوثيق القياسي التفصيلي.`,
    condition_assessment: `توصَف الحالة الراهنة للمنشأة بأنها ${context.project.currentCondition}. وتشمل الملاحظات المتعلقة بالأضرار والحالة ما يلي: ${context.project.conditionAndDamage} ${service1 ? `كما توفرت ${service1.imageCount} مخرجات مرجعية بصرية تدعم قراءة المظاهر المتدهورة أو العناصر غير الواضحة وتتيح مقارنة بصرية مساندة للتوثيق.` : 'لم تتوفر حزمة مرجعية بصرية إضافية، ولذلك تبقى قراءة الحالة معتمدة على الوصف المقدم والملفات الداعمة فقط.'}`,
    heritage_value: `تتلخص القيمة التراثية المقدمة للمنشأة فيما يلي: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `كما دعمت القراءة المعمارية الإضافية هذا التقييم ببيان أن القيمة التراثية تتمثل في: ${service2.styleAnalysis.heritageValue}.` : ''} وينبغي أن يوجّه هذا التقييم ترتيب أولويات التدخل بما يضمن حماية العناصر والمواد والعلاقات الفراغية ذات الأهمية الأعلى.`,
    urban_context: `${service3 ? `يقع المشروع ضمن نطاق ${service3.districtName || 'سياقه العمراني الأوسع'}${service3.city ? ` في ${service3.city}` : ''}. كما وصفت القراءة العمرانية المتاحة النمط العام بأنه ${service3.urbanAnalysis.urbanPattern || 'غير محدد بدقة'}، مع إبراز السمات التالية: ${(service3.urbanAnalysis.keyFeatures || []).join('، ') || 'لم تُسجل سمات محددة'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `يتمثل السياق الجغرافي والعمراني المقدم للموقع في الآتي: ${context.project.geographicContext} ولم تتوفر بيانات عمرانية إضافية، لذلك يبقى تفسير السياق العام معتمداً على الملاحظات النصية لا على تحليل جغرافي رسمي.`}`,
    rehabilitation_strategy: `تتمثل استراتيجية التأهيل المقترحة فيما يلي: ${context.project.rehabilitationStrategy} أما الوظيفة المستهدفة فهي ${context.project.targetFunction}، ويُعرض مفهوم إعادة الاستخدام على النحو الآتي: ${context.project.adaptiveReuseConcept} وبناءً على ذلك يجب أن توازن الاستراتيجية بين صون السمات الأصيلة للمنشأة وبين متطلبات التشغيل الجديد والسلامة وسهولة الوصول واستدامة الصيانة.`,
    proposed_interventions: `استناداً إلى الأدلة المتاحة، ينبغي أن تعطي التدخلات المقترحة الأولوية للتوثيق والاستقرار الإنشائي والمعالجات المحافظة وإصلاح الأجزاء المتضررة وتأهيل الأنظمة الخدمية بما يتوافق مع إعادة الاستخدام. كما يجب أن تكون الإضافات الجديدة قابلة للتمييز في التوثيق مع الحفاظ على التوافق البصري والمادي مع الطابع التاريخي للمبنى، مع التوصية باستكمال دراسات تخصصية للهيكل والمواد والخدمات والاشتراطات قبل التنفيذ.`,
    feasibility: `ترتبط الجدوى بالحالة الفنية ومدى ملاءمة إعادة الاستخدام وإمكانات القبول التنظيمي والتخطيط المالي والتشغيلي. ولذلك يُستحسن تنفيذ المشروع على مراحل تبدأ بالتوثيق والتحقق، ثم التثبيت العاجل، ثم تطوير التصميم والحصول على الموافقات والتنفيذ. كما قد تتطلب مرحلة الجدوى التفصيلية إعداد تقديرات تكاليف وتحليل مراحل التنفيذ ودراسة التشغيل المستقبلي للوظيفة المستهدفة.`,
    sustainability: `يجب فهم الاستدامة في هذا المشروع عبر أبعادها البيئية والاجتماعية والاقتصادية. فالقيمة البيئية تتحقق من خلال الحفاظ على الطاقة الكامنة في المواد وتقليل الاستبدال غير الضروري، بينما تتمثل القيمة الاجتماعية في استمرارية الهوية التراثية وتعزيز الذاكرة المحلية، وتظهر القيمة الاقتصادية في تفعيل المنشأة عبر إعادة الاستخدام بصورة قابلة للاستدامة. ويمكن تعزيز هذا البعد من خلال إصلاح منخفض الأثر واختيار مواد متينة ووضع خطة صيانة طويلة الأمد.`,
    standards_compliance: `ينبغي قراءة المشروع في ضوء ملف المعايير المختار، مع الإقرار بأن الامتثال النهائي يحتاج إلى مراجعة خاصة بالمشروع والجهة المختصة. ويؤكد الإطار المرجعي المضمن على أهمية الدلالة الثقافية والحد الأدنى من التدخل والحفاظ على الأصالة والسلامة وجودة التوثيق والتوافق الوظيفي لإعادة الاستخدام. وعند الحاجة إلى اعتمادات محلية، ينبغي اعتبار هذا التقرير وثيقة مساندة للتقديم لا بديلاً عن المراجعة الرسمية.`,
    implementation: `يوصى بأن يتم التنفيذ عبر مراحل واضحة تشمل التوثيق والتحقق، والفحوصات التخصصية، والمعالجات العاجلة، ثم تطوير التصميم، فالحصول على الموافقات، وأخيراً أعمال التأهيل والتشغيل والمتابعة. كما ينبغي منذ البداية تحديد التدخلات القابلة للعكس والتدخلات الإصلاحية والتعديلات الضرورية لإعادة الاستخدام مع تبريرها فنياً وتراثياً.`,
    conclusion: `تخلص هذه الدراسة إلى أن المشروع يملك إمكانات واضحة للتأهيل التراثي المنظم متى بقيت عملية التدخل قائمة على الأدلة وعلى فهم القيمة التراثية. وتوفر المواد البصرية والمعمارية والسياقية المتاحة دعماً مهماً، إلا أن مراحل التصميم النهائي والاعتماد والتنفيذ تحتاج إلى استكمال التحقق الفني والتنظيمي والتفصيلي.`,
  };

  return Object.fromEntries(
    Object.keys(english).map(key => [
      key,
      localizeTemplateText(english[key], arabic[key], context.report.language),
    ]),
  );
}

function buildDocumentationTemplateSectionBodies(context, service1, service2, service3) {
  const english = {
    project_overview: `This documentation report records the heritage asset "${context.project.buildingName}" at ${context.project.location}. It organizes the available descriptive inputs, supporting reference material, and standards context into a documentation-focused dossier intended to support historical recording, architectural interpretation, and heritage decision-making.`,
    historical_background: `Available background information indicates an approximate date of ${context.project.approximateDate}. The supplied historical account states: ${context.project.historicalBackground} This section should be treated as a documentation baseline pending archival verification of chronology, ownership, and phases of alteration.`,
    architectural_description: `The documented architectural character is described as ${context.project.architecturalStyle || 'not fully specified'}. ${service2 ? `Supporting architectural analysis identifies ${service2.styleAnalysis.detectedStyle || service2.style || 'a heritage architectural language'} and notes the following elements: ${(service2.styleAnalysis.elements || []).join(', ') || 'heritage-defining elements were not enumerated'}.` : 'No supplementary architectural analysis was available, so the description relies on the user-provided notes and evidence.'} The focus here is documentation of observed form, material language, and defining features.`,
    condition_assessment: `The current condition is described as ${context.project.currentCondition}. Condition observations include: ${context.project.conditionAndDamage} ${service1 ? `${service1.imageCount} visual reference output(s) were available to support interpretation of damaged or incomplete features.` : 'No supplementary visual reference package was available, so condition interpretation remains limited to the submitted notes and attachments.'}`,
    heritage_value: `The documented heritage significance is summarized as follows: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `Supporting architectural analysis further characterizes the significance as ${service2.styleAnalysis.heritageValue}.` : ''} This section is intended to record why the place matters and which attributes require the greatest protection.`,
    urban_context: `${service3 ? `The asset sits within ${service3.districtName || 'its wider district'}${service3.city ? `, ${service3.city}` : ''}. Available urban analysis describes the setting as ${service3.urbanAnalysis.urbanPattern || 'not fully classified'}, with key features including ${(service3.urbanAnalysis.keyFeatures || []).join(', ') || 'no specific features recorded'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `The supplied geographic and urban note states: ${context.project.geographicContext} No supplementary urban dataset was linked, so district-scale interpretation remains limited to this submitted note.`}`,
    documentation_scope: `The evidence base for this report consists of project metadata, descriptive notes, uploaded files, and any linked supporting analyses. Documentation coverage currently prioritizes historical narrative, architectural description, observed condition, contextual reading, and standards references. Missing dimensions should be flagged for future measured survey, archival verification, and specialist inspection where necessary.`,
    standards_compliance: `The documentation should be interpreted against the selected standards profile while recognizing that formal compliance still requires project-specific review. At this stage, the standards function primarily as documentation criteria for significance, authenticity, integrity, and conservation readiness rather than as proof of final approval.`,
    conservation_notes: `Documentation findings suggest that future conservation work should preserve character-defining materials, confirm undocumented phases of change, and complete measured recording before major intervention. The present report is therefore best understood as a documentation dossier that informs later design, conservation, and approval steps.`,
    conclusion: `In conclusion, the available information supports a coherent documentation profile for the asset, centered on historical context, architectural character, condition, and heritage value. The next priority is to deepen the evidence base through verification, measured recording, and specialist conservation review.`,
  };

  const arabic = {
    project_overview: `يوثق هذا التقرير التوثيقي الأصل التراثي "${context.project.buildingName}" الواقع في ${context.project.location}. ويجمع التقرير البيانات الوصفية المتاحة والمواد المرجعية والتحليلات المساندة ضمن ملف يركز على التوثيق التاريخي والمعماري والتراثي لدعم القراءة العلمية واتخاذ القرار.`,
    historical_background: `تشير المعلومات المتاحة إلى أن التاريخ التقريبي للأصل هو ${context.project.approximateDate}. وتتمثل الخلفية التاريخية المقدمة فيما يلي: ${context.project.historicalBackground} وينبغي التعامل مع هذه المادة بوصفها خط أساس توثيقياً يحتاج إلى استكمال بالتحقق الأرشيفي والتاريخي عند الحاجة.`,
    architectural_description: `يوصف الطابع المعماري الموثق بأنه ${context.project.architecturalStyle || 'غير محدد بشكل كاف'}. ${service2 ? `وتشير القراءة المعمارية المساندة إلى أن النمط الأقرب هو ${service2.styleAnalysis.detectedStyle || service2.style || 'طراز تراثي'}، مع إبراز العناصر التالية: ${(service2.styleAnalysis.elements || []).join('، ') || 'لم يتم حصر العناصر المميزة بشكل مفصل'}.` : 'ولم تتوفر قراءة معمارية إضافية، لذلك يعتمد هذا القسم على الوصف المقدم والمواد الداعمة المتاحة.'} ويركز هذا القسم على توثيق الشكل العام والمواد والعناصر المميزة للمبنى.`,
    condition_assessment: `توصف الحالة الراهنة للمنشأة بأنها ${context.project.currentCondition}. وتشمل الملاحظات المرتبطة بالحالة والأضرار ما يلي: ${context.project.conditionAndDamage} ${service1 ? `كما توفرت ${service1.imageCount} مخرجات مرجعية بصرية تساعد على قراءة العناصر المتضررة أو غير المكتملة.` : 'ولم تتوفر حزمة مرجعية بصرية إضافية، لذلك تبقى قراءة الحالة معتمدة على الملاحظات النصية والملفات المرفقة.'}`,
    heritage_value: `تتلخص القيمة التراثية الموثقة للمنشأة فيما يلي: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `كما دعمت القراءة المعمارية المساندة هذا التقييم ببيان أن القيمة التراثية تتمثل في: ${service2.styleAnalysis.heritageValue}.` : ''} ويهدف هذا القسم إلى تسجيل أسباب الأهمية وتحديد السمات التي تتطلب أعلى درجات الحماية.`,
    urban_context: `${service3 ? `تقع المنشأة ضمن نطاق ${service3.districtName || 'سياقها العمراني الأوسع'}${service3.city ? ` في ${service3.city}` : ''}. كما تصف القراءة العمرانية المتاحة النمط العام بأنه ${service3.urbanAnalysis.urbanPattern || 'غير محدد بدقة'}، مع إبراز السمات التالية: ${(service3.urbanAnalysis.keyFeatures || []).join('، ') || 'لم تسجل سمات محددة'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `يتضمن الوصف الجغرافي والعمراني المقدم ما يلي: ${context.project.geographicContext} ولم تتوفر بيانات عمرانية إضافية، لذلك تبقى قراءة السياق العام معتمدة على هذا الوصف المقدم.`}`,
    documentation_scope: `تعتمد قاعدة الأدلة في هذا التقرير على بيانات المشروع، والملاحظات الوصفية، والملفات المرفوعة، وأي تحليلات مساندة مرتبطة. ويركز نطاق التوثيق الحالي على الخلفية التاريخية والوصف المعماري والحالة الراهنة والسياق العام والقيمة التراثية. أما الجوانب غير المكتملة فتتطلب استكمال الرفع المعماري والتوثيق القياسي والتحقق الأرشيفي والفحوص المتخصصة.`,
    standards_compliance: `يجب قراءة هذا الملف التوثيقي في ضوء حزمة المعايير المختارة، مع الإقرار بأن الامتثال الرسمي النهائي يحتاج إلى مراجعة خاصة بالمشروع. وفي هذه المرحلة، تعمل المعايير كمرجع توثيقي لضبط مفاهيم القيمة والأصالة والسلامة وجاهزية الحفظ أكثر من كونها إثباتاً لاعتماد نهائي.`,
    conservation_notes: `تشير نتائج التوثيق إلى ضرورة الحفاظ على العناصر الأصيلة، والتحقق من مراحل التغيير غير الموثقة، واستكمال الرفع القياسي قبل أي تدخل رئيسي. ولذلك ينبغي النظر إلى هذا التقرير باعتباره ملفاً توثيقياً يؤسس للمراحل اللاحقة من الحفظ والتصميم والاعتماد.`,
    conclusion: `تخلص هذه الوثيقة إلى أن المعلومات المتاحة تسمح ببناء ملف توثيقي مترابط للأصل، يركز على الخلفية التاريخية والطابع المعماري والحالة والقيمة التراثية. وتتمثل الأولوية التالية في تعميق قاعدة الأدلة عبر التحقق والرفع المعماري والفحوص المتخصصة.`,
  };

  return Object.fromEntries(
    getReportStructure('documentation').map(sectionId => [
      sectionId,
      localizeTemplateText(english[sectionId] || 'Section content was not available.', arabic[sectionId] || 'لم تتوفر مادة لهذا القسم.', context.report.language),
    ]),
  );
}

function buildAcademicTemplateSectionBodies(context, service1, service2, service3) {
  const english = {
    research_framework: `This academic heritage report examines "${context.project.buildingName}" as a heritage case study. The central research concern is how the asset's historical, architectural, and contextual values can be interpreted through the currently available evidence and what conservation implications emerge from that reading.`,
    methodology: `The report adopts a document-based analytical method using project metadata, descriptive notes, linked analytical outputs, and any uploaded evidence. Because the evidence base is partial, the method emphasizes source criticism, triangulation between descriptive and visual inputs, and explicit acknowledgement of documentation gaps.`,
    historical_background: `The asset is associated with an approximate date of ${context.project.approximateDate}. The available historical narrative is: ${context.project.historicalBackground} From an academic standpoint, the current historical account should be treated as a provisional research input rather than a closed historical conclusion.`,
    architectural_description: `Architecturally, the asset is described as ${context.project.architecturalStyle || 'not fully specified'}. ${service2 ? `Supporting architectural analysis suggests ${service2.styleAnalysis.detectedStyle || service2.style || 'a heritage architectural language'} and identifies ${(service2.styleAnalysis.elements || []).join(', ') || 'no fully enumerated defining elements'}.` : 'No supplementary architectural analysis was available, so this discussion depends primarily on the submitted notes and evidence.'} The section interprets these features as evidence for the building's formal and material identity.`,
    condition_assessment: `The recorded condition is ${context.project.currentCondition}. Observed damage includes: ${context.project.conditionAndDamage} ${service1 ? `${service1.imageCount} visual reference output(s) were available to support interpretation of deterioration and loss.` : 'No supplementary visual reference package was available for deeper interpretive comparison.'} Condition is discussed here not only as a technical issue but also as a factor shaping the evidentiary reliability of the site.`,
    heritage_value: `The reported heritage significance is: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `Additional architectural reading describes the heritage value as ${service2.styleAnalysis.heritageValue}.` : ''} This section interprets significance as a layered construct involving material, aesthetic, cultural, and contextual value.`,
    urban_context: `${service3 ? `The wider setting is read through ${service3.districtName || 'the surrounding district'}${service3.city ? ` in ${service3.city}` : ''}. Available urban analysis identifies ${service3.urbanAnalysis.urbanPattern || 'an incompletely classified pattern'} and features such as ${(service3.urbanAnalysis.keyFeatures || []).join(', ') || 'no specifically recorded features'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `The submitted urban and geographic note states: ${context.project.geographicContext} In the absence of a linked spatial dataset, contextual interpretation remains provisional.`}`,
    comparative_discussion: `Taken together, the historical account, architectural reading, condition observations, and contextual evidence suggest a heritage asset whose significance depends on the relationship between character-defining fabric, urban memory, and the viability of future conservation. The discussion therefore positions the project as a research case requiring further verification rather than a fully resolved design proposition.`,
    standards_compliance: `From an academic perspective, the selected standards profile is useful as an interpretive framework for significance, authenticity, integrity, and conservation reasoning. The standards are therefore discussed here as analytical lenses rather than as a substitute for formal regulatory clearance.`,
    conclusion: `In conclusion, the case supports a research-oriented reading of the asset in which heritage value, condition, and context must be interpreted together. Further archival work, measured documentation, and specialist investigation would strengthen the study and refine subsequent conservation conclusions.`,
  };

  const arabic = {
    research_framework: `يتناول هذا التقرير الأكاديمي "${context.project.buildingName}" بوصفه حالة تراثية للدراسة. وتتمثل الإشكالية البحثية في كيفية تفسير القيم التاريخية والمعمارية والسياقية للأصل في ضوء الأدلة المتاحة حالياً، وما الذي يترتب على ذلك من دلالات حفظية.`,
    methodology: `يعتمد التقرير على منهج تحليلي قائم على قراءة بيانات المشروع والملاحظات الوصفية والمخرجات التحليلية المرتبطة وأي مواد مرفوعة. ونظراً لأن قاعدة الأدلة جزئية، تؤكد المنهجية على نقد المصادر، والمقارنة بين المدخلات النصية والبصرية، والتصريح الواضح بحدود المعلومات المتوفرة.`,
    historical_background: `يرتبط الأصل بتاريخ تقريبي هو ${context.project.approximateDate}. أما الخلفية التاريخية المتاحة فهي: ${context.project.historicalBackground} ومن منظور أكاديمي، ينبغي التعامل مع هذه المادة بوصفها معطى بحثياً أولياً لا نتيجة تاريخية نهائية.`,
    architectural_description: `معمارياً، يوصف الأصل بأنه ${context.project.architecturalStyle || 'غير محدد بشكل كاف'}. ${service2 ? `وتشير القراءة المعمارية المساندة إلى أن النمط الأقرب هو ${service2.styleAnalysis.detectedStyle || service2.style || 'طراز تراثي'}، مع تحديد ${(service2.styleAnalysis.elements || []).join('، ') || 'عناصر غير محصورة بشكل كامل'}.` : 'ولم تتوفر قراءة معمارية إضافية، لذا يعتمد هذا التحليل أساساً على الوصف المقدم والمواد المتاحة.'} ويقرأ هذا القسم تلك السمات باعتبارها أدلة على الهوية الشكلية والمادية للمبنى.`,
    condition_assessment: `الحالة المسجلة للمبنى هي ${context.project.currentCondition}. وتشمل المظاهر الملحوظة للأضرار ما يلي: ${context.project.conditionAndDamage} ${service1 ? `كما توفرت ${service1.imageCount} مخرجات مرجعية بصرية تدعم تفسير مظاهر التدهور أو الفقد.` : 'ولم تتوفر حزمة مرجعية بصرية إضافية لتعميق المقارنة التحليلية.'} ويُناقش هذا القسم الحالة ليس فقط كمعطى فني، بل أيضاً كعامل يؤثر في موثوقية الأدلة الميدانية.`,
    heritage_value: `تتمثل القيمة التراثية المعلنة فيما يلي: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `كما قدمت القراءة المعمارية الإضافية توصيفاً للقيمة التراثية يتمثل في: ${service2.styleAnalysis.heritageValue}.` : ''} ويقارب هذا القسم القيمة بوصفها بناءً مركباً يجمع بين القيمة المادية والجمالية والثقافية والسياقية.`,
    urban_context: `${service3 ? `يُقرأ السياق الأوسع من خلال ${service3.districtName || 'النطاق العمراني المحيط'}${service3.city ? ` في ${service3.city}` : ''}. وتشير القراءة العمرانية المتاحة إلى نمط عام هو ${service3.urbanAnalysis.urbanPattern || 'غير مصنف بشكل كاف'}، مع إبراز سمات مثل ${(service3.urbanAnalysis.keyFeatures || []).join('، ') || 'عدم توافر سمات مسجلة بشكل تفصيلي'}. ${service3.urbanAnalysis.restorationNotes || ''}` : `أما الملاحظة الجغرافية والعمرانية المقدمة فتتمثل في: ${context.project.geographicContext} وفي غياب بيانات مكانية إضافية، تبقى قراءة السياق مؤقتة وقابلة للمراجعة.`}`,
    comparative_discussion: `يكشف الجمع بين الخلفية التاريخية والتحليل المعماري وملاحظات الحالة والسياق العام عن أصل تراثي تتشكل قيمته من العلاقة بين النسيج المعماري المميز والذاكرة العمرانية وإمكانات الحفظ المستقبلية. ولذلك تُقدَّم هذه الدراسة بوصفها قراءة بحثية مفتوحة تحتاج إلى مزيد من التحقق، لا بوصفها حلاً تصميمياً نهائياً.`,
    standards_compliance: `من منظور أكاديمي، تمثل حزمة المعايير المختارة إطاراً تفسيرياً يساعد على مناقشة مفاهيم القيمة والأصالة والسلامة ومنطق الحفظ. ولذلك تُستخدم المعايير هنا بوصفها عدسة تحليلية وليست بديلاً عن المراجعة النظامية أو الاعتماد الرسمي.`,
    conclusion: `تخلص الدراسة إلى أن هذه الحالة تدعم قراءة بحثية تربط بين القيمة التراثية والحالة الراهنة والسياق العام بوصفها عناصر متداخلة. كما أن تعميق البحث الأرشيفي واستكمال الرفع القياسي والفحوص التخصصية من شأنه أن يعزز نتائج الدراسة ويصقل خلاصاتها الحفظية.`,
  };

  return Object.fromEntries(
    getReportStructure('academic').map(sectionId => [
      sectionId,
      localizeTemplateText(english[sectionId] || 'Section content was not available.', arabic[sectionId] || 'لم تتوفر مادة لهذا القسم.', context.report.language),
    ]),
  );
}

function buildFeasibilityTemplateSectionBodies(context, service1, service2, service3) {
  const english = {
    project_overview: `This feasibility study assesses whether the proposed future use for "${context.project.buildingName}" at ${context.project.location} appears viable on the basis of available heritage, condition, contextual, and operational information. The study treats feasibility as a balance between conservation obligations, operational practicality, implementation readiness, and manageable risk.`,
    heritage_value: `The asset's heritage value is summarized as follows: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `Supporting architectural analysis further notes that ${service2.styleAnalysis.heritageValue}.` : ''} Any feasible scenario must therefore protect the attributes that carry this significance while limiting interventions that would compromise authenticity or legibility.`,
    technical_feasibility: `From a technical perspective, the current condition is described as ${context.project.currentCondition}, with the following issues recorded: ${context.project.conditionAndDamage} ${service1 ? `${service1.imageCount} visual reference output(s) were available to support technical interpretation of visible deterioration.` : 'No supplementary visual reference package was available for detailed technical comparison.'} Technical feasibility therefore depends on the degree of structural stabilization, fabric repair, services upgrading, and specialist conservation input required before reuse can occur.`,
    operational_feasibility: `Operationally, the target function is ${context.project.targetFunction}, and the adaptive reuse concept is described as: ${context.project.adaptiveReuseConcept} The key operational question is whether the proposed use can be accommodated while maintaining heritage character, safe circulation, accessibility, maintenance capacity, and day-to-day management practicality.`,
    financial_feasibility: `Financial feasibility cannot be confirmed without a dedicated cost plan, but the current evidence indicates that expenditure would likely be driven by documentation effort, stabilization, conservation repair, compatible upgrades, and phased delivery. A viable scenario would require prioritization, sequencing, and realistic resource planning aligned with the significance of the asset and the complexity of the proposed reuse.`,
    implementation_strategy: `Implementation feasibility depends on a phased route that begins with verification and specialist investigation, then moves through urgent protection, design development, approvals, procurement, works, and monitored operation. The project appears more implementable if it is broken into manageable packages tied to condition urgency, conservation priority, and funding availability.`,
    risk_assessment: `${service3 ? `Contextual risks are influenced by the surrounding urban setting in ${service3.districtName || 'the wider district'}, where urban conditions may affect access, logistics, and compatibility.` : 'Contextual risks must be inferred from the submitted geographic note because no linked spatial dataset was available.'} Key risks include under-documented condition, hidden defects, regulatory mismatch, budget escalation, operational underperformance, and inappropriate interventions that weaken heritage value. Risk mitigation should therefore rely on phased verification, specialist review, and conservative intervention planning.`,
    standards_compliance: `Feasibility should be assessed against the selected standards profile to ensure that viability is not judged on operational criteria alone. A scenario is only truly feasible if it can accommodate heritage significance, documentation requirements, authenticity, safety, and regulatory review together.`,
    sustainability: `Long-term feasibility is strengthened when the project retains embodied material value, sustains cultural identity, and supports a realistic operational model. Sustainability here is therefore part of viability: a project is more feasible when its environmental, social, and economic logic can be maintained over time.`,
    conclusion: `In conclusion, the project appears conditionally feasible rather than unconditionally ready. Its viability depends on disciplined phasing, technical verification, careful conservation planning, operational realism, and risk control. The next step should be a more detailed feasibility package combining technical studies, cost planning, and implementation governance.`,
  };

  const arabic = {
    project_overview: `تقيّم هذه الدراسة مدى جدوى تنفيذ المشروع المقترح للأصل "${context.project.buildingName}" الواقع في ${context.project.location} استناداً إلى المعلومات التراثية والفنية والسياقية والتشغيلية المتاحة. وتُفهم الجدوى هنا بوصفها توازناً بين متطلبات الحفظ وإمكانات التشغيل وقابلية التنفيذ وإدارة المخاطر.`,
    heritage_value: `تتلخص القيمة التراثية للأصل فيما يلي: ${context.project.heritageSignificance} ${service2?.styleAnalysis?.heritageValue ? `كما تشير القراءة المعمارية المساندة إلى أن ${service2.styleAnalysis.heritageValue}.` : ''} ولذلك فإن أي سيناريو قابل للتنفيذ يجب أن يحافظ على السمات الحاملة لهذه القيمة، وأن يحد من التدخلات التي تضعف الأصالة أو وضوح القراءة التاريخية.`,
    technical_feasibility: `من الناحية الفنية، توصف الحالة الراهنة بأنها ${context.project.currentCondition}، مع تسجيل الملاحظات التالية: ${context.project.conditionAndDamage} ${service1 ? `كما توفرت ${service1.imageCount} مخرجات مرجعية بصرية تدعم قراءة مظاهر التدهور الظاهرة.` : 'ولم تتوفر حزمة مرجعية بصرية إضافية تسمح بمقارنة فنية أعمق.'} وعليه فإن الجدوى الفنية ترتبط بمدى الحاجة إلى التثبيت والإنقاذ وإصلاح النسيج ورفع كفاءة الخدمات واستكمال الفحوص التخصصية قبل إعادة الاستخدام.`,
    operational_feasibility: `تشغيلياً، تتمثل الوظيفة المستهدفة في ${context.project.targetFunction}، بينما يرد مفهوم إعادة الاستخدام على النحو الآتي: ${context.project.adaptiveReuseConcept} وتتمثل المسألة التشغيلية الأساسية في مدى إمكانية استيعاب هذا الاستخدام المقترح دون الإضرار بالشخصية التراثية، مع ضمان الحركة الآمنة، وإمكانية الوصول، والقدرة على الإدارة والصيانة اليومية.`,
    financial_feasibility: `لا يمكن حسم الجدوى المالية دون إعداد تقدير تكاليف تفصيلي، إلا أن المعطيات الحالية تشير إلى أن التكلفة ستتأثر بأعمال التوثيق، والتثبيت، والإصلاح المحافظ، والتحديثات المتوافقة، والتنفيذ المرحلي. وتتحقق الجدوى المالية بصورة أفضل عندما يرتبط المشروع بأولويات واضحة وجدولة مرحلية واقعية وخطة موارد منسجمة مع قيمة الأصل وتعقيد إعادة الاستخدام المقترحة.`,
    implementation_strategy: `ترتبط الجدوى التنفيذية بمسار مرحلي يبدأ بالتحقق والفحوص التخصصية، ثم الحماية العاجلة، فالتطوير التصميمي، فالموافقات، فالتنفيذ، وأخيراً التشغيل والمتابعة. ويصبح المشروع أكثر قابلية للتنفيذ عندما يقسم إلى حزم واضحة ترتبط بأولوية الحالة والقيمة التراثية وتوفر التمويل.`,
    risk_assessment: `${service3 ? `تتأثر المخاطر السياقية أيضاً بالوضع العمراني المحيط في ${service3.districtName || 'النطاق العمراني الأوسع'}، حيث قد تؤثر ظروف الوصول واللوجستيات والتوافق الحضري على التنفيذ.` : 'أما المخاطر السياقية فتستنتج من الملاحظة الجغرافية المقدمة لعدم توفر بيانات مكانية إضافية.'} وتشمل المخاطر الأساسية نقص توثيق الحالة، والعيوب الخفية، وعدم التوافق التنظيمي، وتصاعد الكلفة، وضعف الأداء التشغيلي، أو التدخلات غير الملائمة التي تضعف القيمة التراثية. ولذلك يجب أن تعتمد المعالجة على التحقق المرحلي والمراجعة التخصصية والتخطيط المحافظ للتدخل.`,
    standards_compliance: `ينبغي تقييم الجدوى في ضوء حزمة المعايير المختارة حتى لا تُفهم القابلية للتنفيذ من منظور تشغيلي أو مالي فقط. فالسيناريو لا يعد مجدياً بصورة حقيقية إلا إذا أمكنه استيعاب متطلبات القيمة التراثية والتوثيق والأصالة والسلامة والمراجعة التنظيمية في آن واحد.`,
    sustainability: `تتعزز الجدوى طويلة الأمد عندما يحافظ المشروع على القيمة الكامنة في المواد والهوية الثقافية ويستند إلى نموذج تشغيل واقعي. ومن ثم فإن الاستدامة هنا جزء من منطق الجدوى نفسه: فالمشروع يكون أكثر قابلية للتنفيذ عندما تكون أبعاده البيئية والاجتماعية والاقتصادية قابلة للاستمرار مع الزمن.`,
    conclusion: `تخلص الدراسة إلى أن المشروع يبدو مجدياً بشروط، لا جاهزاً بصورة مطلقة. إذ ترتبط قابليته للتنفيذ بالتحقق الفني المرحلي، والتخطيط الحفظي الدقيق، والواقعية التشغيلية، وضبط المخاطر. وتتمثل الخطوة التالية في إعداد حزمة جدوى تفصيلية تجمع بين الدراسات الفنية وتقدير التكاليف وحوكمة التنفيذ.`,
  };

  return Object.fromEntries(
    getReportStructure('feasibility').map(sectionId => [
      sectionId,
      localizeTemplateText(english[sectionId] || 'Section content was not available.', arabic[sectionId] || 'لم تتوفر مادة لهذا القسم.', context.report.language),
    ]),
  );
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
  const jobDir = path.join(OUTPUTS_DIR, jobId);
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
    preview: buildJobOutputPreview(jobId, meta, jobDir),
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

const OUTPUT_PREVIEW_PRIORITY = [
  'png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx', 'pptx', 'xlsx',
  'dxf', 'svg', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'geojson', 'kml', 'kmz', 'json',
];

function outputPreviewPriority(ext = '') {
  const normalized = String(ext || '').toLowerCase();
  const index = OUTPUT_PREVIEW_PRIORITY.indexOf(normalized);
  return index === -1 ? OUTPUT_PREVIEW_PRIORITY.length + 1 : index;
}

function prettifyOutputName(fileName = '') {
  return String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildJobOutputPreview(jobId, meta = {}, jobDir) {
  const files = collectOutputFiles(jobDir).filter(file => file.ext && file.name !== 'metadata.json');
  const previewImages = getRepresentativeImagePaths(meta, jobDir)
    .slice(0, 4)
    .map((imagePath, index) => ({
      url: relOutputUrl(jobId, imagePath),
      label: `Preview ${index + 1}`,
    }));

  const outputFiles = files
    .slice()
    .sort((a, b) => {
      const priorityDiff = outputPreviewPriority(a.ext) - outputPreviewPriority(b.ext);
      if (priorityDiff !== 0) return priorityDiff;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 12)
    .map(file => ({
      label: prettifyOutputName(file.name),
      url: relOutputUrl(jobId, file.path),
      ext: file.ext,
    }));

  const summary = meta.service === 1
    ? `${meta.imageCount || previewImages.length || 0} restored image(s)`
    : meta.service === 2
      ? `${meta.viewsGenerated || previewImages.length || 0} architectural view(s)`
      : meta.service === 3
        ? `${previewImages.length || 0} urban preview image(s)`
        : `${files.length} output file(s)`;

  return {
    summary,
    totalFiles: files.length,
    previewImages,
    outputFiles,
  };
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

function buildStandardsProfile(standardProfile = 'both', language = 'english') {
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
  return base.map(item => localizeStandardItem(item, language));
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
  return getReportStructure(context.report.type).map(sectionId => ({
    id: sectionId,
    title: getSectionTitle(sectionId, context.report.language),
  }));
}

function buildModelContext(input, linkedJobs, uploadedFilesSummary) {
  const service1 = linkedJobs.find(job => job.service === 1) || null;
  const service2 = linkedJobs.find(job => job.service === 2) || null;
  const service3 = linkedJobs.find(job => job.service === 3) || null;
  const reportType = normalizeReportType(input.reportType);
  const reportTypeLabel = normalizeText(input.reportType, getReportTypeUiLabel(reportType));

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
      type: reportType,
      typeLabel: reportTypeLabel,
      mode: normalizeText(input.reportMode, 'professional'),
      language: normalizeText(input.language, 'arabic').toLowerCase() === 'english' ? 'english' : 'arabic',
      depth: normalizeText(input.depth, 'medium'),
      standardsProfile: normalizeText(input.standardProfile, 'both'),
      aiModel: normalizeAiModel(input.aiModel, 'gpt'),
      aiModelLabel: getAiModelLabel(input.aiModel, 'gpt'),
    },
    linkedServices: {
      service1,
      service2,
      service3,
      all: linkedJobs,
    },
    uploadedEvidence: uploadedFilesSummary,
  };

  context.standards = buildStandardsProfile(context.report.standardsProfile, context.report.language);
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
  return parseModelJsonObject(text);
}

const SERVICE_04_PROMPT_DEFAULTS = {
  systemPrompt: [
    'You are a heritage conservation reporting specialist.',
    'Write like a real academic, professional, or governmental heritage consultant.',
    'Use only the supplied project context and state limitations when information is missing.',
    'Do not mention internal service names, service numbers, or platform workflow details in the report; describe supporting inputs generically as reference materials, analyses, documentation, or visual evidence.',
    'Do not fabricate measurements, dates, legal approvals, or citations beyond the provided frameworks.',
    'Return valid JSON only.',
  ].join(' '),
  userPromptTemplate: [
    'Prepare a [REPORT_MODE_LABEL] [REPORT_TYPE_LABEL].',
    'Selected report type label in the website UI: "[REPORT_TYPE_UI_LABEL]". This exact label is the primary switch for the report structure.',
    '[LANGUAGE_INSTRUCTION]',
    'Depth requirement: [DEPTH_REQUIREMENT].',
    'Tone: [TONE]. Secondary presentation mode nuance: [MODE_TONE].',
    '[OBJECTIVE]',
    '[EMPHASIS]',
    'Organize the report into the requested sections and keep the writing formal, evidence-based, and heritage-aware.',
    'Do not reuse the same structure across documentation, academic, and feasibility report types.',
    'For standards and compliance, discuss framework relevance, likely alignment, and any validation still required inside the narrative sections and recommendations. The detailed standards checklist and sustainability matrix will be completed from the supplied frameworks separately.',
    'Return only this JSON shape:',
    '[JSON_SCHEMA]',
    'Project context:',
    '[PROJECT_CONTEXT_JSON]',
  ].join('\n\n'),
};

function buildService4PromptConfig(input = {}) {
  return {
    systemPrompt: typeof input.systemPrompt === 'string'
      ? input.systemPrompt.replace(/\r\n/g, '\n').trim()
      : SERVICE_04_PROMPT_DEFAULTS.systemPrompt,
    userPromptTemplate: typeof input.userPromptTemplate === 'string'
      ? input.userPromptTemplate.replace(/\r\n/g, '\n').trim()
      : SERVICE_04_PROMPT_DEFAULTS.userPromptTemplate,
  };
}

function parseService4PromptConfig(rawValue) {
  if (!rawValue) return buildService4PromptConfig();
  if (typeof rawValue === 'object') return buildService4PromptConfig(rawValue);

  try {
    return buildService4PromptConfig(JSON.parse(String(rawValue)));
  } catch (error) {
    throw new Error('Service 04 prompt configuration must be valid JSON.');
  }
}

function renderService4PromptTemplate(template, replacements = {}) {
  return String(template || '')
    .replace(/\r\n/g, '\n')
    .replace(/\[([A-Z0-9_]+)\]/g, (_, key) => {
      const replacement = replacements[key];
      return replacement == null ? '' : String(replacement);
    })
    .trim();
}

function buildPromptBundle(context, promptConfig = buildService4PromptConfig()) {
  const localizedContext = localizedContextView(context);
  const promptProject = localizedContext.project;
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
  const typeProfile = getReportTypePromptProfile(context.report.type, context.report.language);

  const languageInstruction = {
    arabic: 'Write the entire report in Arabic. All section titles, summaries, recommendations, and section bodies must be in Arabic script. Translate English source notes into Arabic and do not write the main narrative in English.',
    english: 'Write the entire report in English. Translate Arabic source notes into English and do not reproduce Arabic script in the narrative, section titles, or recommendations.',
    bilingual: 'Write each section in bilingual format: Arabic first, then English. Section titles should also be bilingual.',
  };

  const contextForModel = {
    project: promptProject,
    report: {
      ...localizedContext.report,
      reportTypeLabel: getReportTypeLabelLocalized(localizedContext.report.type, localizedContext.report.language),
      reportTypeUiLabel: localizedContext.report.typeLabel || getReportTypeUiLabel(localizedContext.report.type),
      reportModeLabel: REPORT_MODE_LABELS[localizedContext.report.mode] || localizedContext.report.mode,
      languageLabel: LANGUAGE_LABELS[localizedContext.report.language] || localizedContext.report.language,
      depthLabel: DEPTH_LABELS[localizedContext.report.depth] || localizedContext.report.depth,
    },
    linkedServices: localizedContext.linkedServices,
    evidenceSummary: localizedContext.evidenceSummary,
    standards: localizedContext.standards,
    sections: localizedContext.sections,
  };

  const systemPrompt = promptConfig.systemPrompt;
  const userPrompt = renderService4PromptTemplate(promptConfig.userPromptTemplate, {
    REPORT_MODE_LABEL: REPORT_MODE_LABELS[context.report.mode] || context.report.mode,
    REPORT_TYPE_LABEL: getReportTypeLabelLocalized(context.report.type, context.report.language),
    REPORT_TYPE_UI_LABEL: context.report.typeLabel || getReportTypeUiLabel(context.report.type),
    LANGUAGE_INSTRUCTION: languageInstruction[context.report.language] || languageInstruction.english,
    DEPTH_REQUIREMENT: paragraphsByDepth[context.report.depth] || paragraphsByDepth.medium,
    TONE: typeProfile.tone,
    MODE_TONE: modeTone[context.report.mode] || modeTone.professional,
    OBJECTIVE: typeProfile.objective,
    EMPHASIS: typeProfile.emphasis,
    JSON_SCHEMA: JSON.stringify({
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
    PROJECT_CONTEXT_JSON: JSON.stringify(contextForModel, null, 2),
  });

  return { systemPrompt, userPrompt };
}

async function generateWithOpenAI(context) {
  if (!OpenAI || !process.env.OPENAI_API_KEY) {
    throw new Error('OpenAI provider is not configured.');
  }

  const { systemPrompt, userPrompt } = buildPromptBundle(context);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.SERVICE_04_OPENAI_MODEL || 'openai/gpt-5';

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

function buildTemplateReportMeta(context) {
  const type = normalizeReportType(context.report.type);
  const name = context.project.buildingName;

  const english = {
    documentation: {
      executiveSummary: `This documentation report consolidates the available historical, architectural, and heritage information for ${name}. It is structured as a documentation dossier focused on evidence recording, significance, condition, context, and documentation gaps requiring further verification.`,
      abstract: `The report organizes project metadata, descriptive evidence, and supporting analyses into a heritage documentation package for ${name}. Its emphasis is on historical recording, architectural description, condition documentation, and heritage significance rather than on viability testing or academic argumentation alone.`,
      keywords: ['heritage documentation', 'architectural recording', 'historical background', 'condition survey'],
    },
    academic: {
      executiveSummary: `This academic heritage report examines ${name} as a research case study. It adopts a research-oriented structure centered on methodology, analytical interpretation, heritage significance, and evidence-based discussion in order to frame conservation knowledge rather than only document existing conditions.`,
      abstract: `The report synthesizes project metadata, supporting analyses, and standards references into an academic heritage study for ${name}. It prioritizes research framing, source critique, analytical discussion, and scholarly conclusions about history, architecture, condition, and context.`,
      keywords: ['heritage research', 'architectural analysis', 'conservation theory', 'academic reporting'],
    },
    feasibility: {
      executiveSummary: `This feasibility study evaluates whether the proposed project for ${name} appears viable on technical, operational, financial, implementation, and risk grounds. It balances heritage significance with execution realities in order to support decision-making rather than documentation alone.`,
      abstract: `The report assembles available project metadata, supporting analyses, and standards references into a feasibility study for ${name}. It focuses on viability testing through technical review, operational fit, financial logic, implementation readiness, and risk analysis.`,
      keywords: ['feasibility study', 'technical viability', 'operational analysis', 'risk assessment'],
    },
  };

  const arabic = {
    documentation: {
      executiveSummary: `يجمع هذا التقرير التوثيقي المعلومات التاريخية والمعمارية والتراثية المتاحة حول ${name}. وقد بُني بوصفه ملفاً توثيقياً يركز على تسجيل الأدلة والقيمة والحالة والسياق والثغرات التي تحتاج إلى استكمال وتحقق لاحق.`,
      abstract: `ينظم التقرير بيانات المشروع والأدلة الوصفية والتحليلات المساندة في حزمة توثيق تراثي تخص ${name}. ويركز على التوثيق التاريخي والوصف المعماري وتسجيل الحالة والقيمة التراثية أكثر من تركيزه على اختبار الجدوى أو بناء حجة بحثية خالصة.`,
      keywords: ['التوثيق التراثي', 'التسجيل المعماري', 'الخلفية التاريخية', 'تقييم الحالة'],
    },
    academic: {
      executiveSummary: `يتناول هذا التقرير الأكاديمي ${name} بوصفه حالة بحثية تراثية. ويعتمد بنية بحثية تركز على المنهجية والتحليل والمناقشة العلمية والقيمة التراثية من أجل إنتاج معرفة تفسيرية، لا مجرد وصف للحالة القائمة.`,
      abstract: `يركب التقرير بيانات المشروع والتحليلات المساندة والمراجع المعيارية في دراسة أكاديمية تراثية تخص ${name}. ويعطي الأولوية للإطار البحثي ونقد المصادر والمناقشة التحليلية والخلاصات العلمية المتعلقة بالتاريخ والعمارة والحالة والسياق.`,
      keywords: ['دراسة تراثية', 'تحليل معماري', 'منهجية بحثية', 'تقرير أكاديمي'],
    },
    feasibility: {
      executiveSummary: `تقيّم هذه الدراسة مدى جدوى المشروع المقترح لـ ${name} من النواحي الفنية والتشغيلية والمالية والتنفيذية وتحليل المخاطر. وهي موجهة لدعم القرار عبر الموازنة بين القيمة التراثية ومتطلبات التنفيذ الفعلي.`,
      abstract: `يجمع التقرير بيانات المشروع والتحليلات المساندة والمراجع المعيارية في دراسة جدوى تخص ${name}. ويركز على اختبار القابلية للتنفيذ من خلال المراجعة الفنية وملاءمة التشغيل والمنطق المالي واستراتيجية التنفيذ وتحليل المخاطر.`,
      keywords: ['دراسة جدوى', 'الجدوى الفنية', 'الجدوى التشغيلية', 'تحليل المخاطر'],
    },
  };

  return {
    executiveSummary: localizeTemplateText(english[type].executiveSummary, arabic[type].executiveSummary, context.report.language),
    abstract: localizeTemplateText(english[type].abstract, arabic[type].abstract, context.report.language),
    keywords: context.report.language === 'english'
      ? english[type].keywords
      : context.report.language === 'arabic'
        ? arabic[type].keywords
        : [...arabic[type].keywords.slice(0, 2), ...english[type].keywords.slice(0, 2)],
  };
}

function buildTemplateReport(context) {
  const localizedContext = localizedContextView(context);
  const labels = getStaticLabels(localizedContext.report.language);
  const project = localizedContext.project;
  const templateMeta = buildTemplateReportMeta(localizedContext);
  const title = `${project.buildingName} - ${getReportTypeLabelLocalized(context.report.type, context.report.language)}`;
  const service1 = localizedContext.linkedServices.service1;
  const service2 = localizedContext.linkedServices.service2;
  const service3 = localizedContext.linkedServices.service3;
  const sectionBodies = buildTemplateSectionBodies(localizedContext, service1, service2, service3);

  const sections = localizedContext.sections.map(section => ({
    id: section.id,
    title: section.title,
    body: sectionBodies[section.id] || 'Section content was not available.',
    keyPoints: [],
  }));

  return {
    title,
    executiveSummary: localizeTemplateText(
      `This report consolidates available project metadata and supporting reference material for ${project.buildingName}. It frames the asset's significance, condition, rehabilitation strategy, contextual setting, and standards-based considerations in a structured reporting format suitable for documentation and planning.`,
      `يجمع هذا التقرير بيانات المشروع المتاحة والمواد المرجعية المساندة الخاصة بـ ${project.buildingName}. كما يقدم عرضاً منظماً للقيمة التراثية والحالة الراهنة واستراتيجية التأهيل والسياق العام واعتبارات المعايير ضمن صياغة مناسبة للتوثيق والتخطيط.`,
      context.report.language,
    ),
    abstract: localizeTemplateText(
      `The report synthesizes project metadata, supporting analyses, and standards references into a structured heritage reporting package for ${project.buildingName}. It supports documentation, rehabilitation planning, adaptive reuse reasoning, and official submission preparation.`,
      `يُركب هذا التقرير بيانات المشروع والتحليلات المساندة والمراجع المعيارية في حزمة تقرير تراثي منظمة تخص ${project.buildingName}. ويدعم ذلك أعمال التوثيق والتأهيل وإعادة الاستخدام التكيفي وتجهيز ملفات العرض أو التقديم الرسمي.`,
      context.report.language,
    ),
    keywords: labels.keywords,
    sections,
    standardsChecklist: context.standards.map(item => ({
      framework: item.code,
      principle: item.title,
      application: item.scope,
      status: context.report.language === 'arabic' ? 'قيد التحقق' : context.report.language === 'bilingual' ? 'قيد التحقق / pending verification' : 'pending verification',
    })),
    sustainabilityMatrix: [
      {
        dimension: context.report.language === 'arabic' ? 'بيئي' : context.report.language === 'bilingual' ? 'بيئي / environmental' : 'environmental',
        consideration: localizeTemplateText('Retention of embodied material value', 'الحفاظ على القيمة الكامنة في المواد والكتلة البنائية', context.report.language),
        projectResponse: localizeTemplateText('Prioritize repair, selective replacement, and low-impact material strategies.', 'إعطاء الأولوية للإصلاح والاستبدال الانتقائي واستراتيجيات المواد منخفضة الأثر.', context.report.language),
      },
      {
        dimension: context.report.language === 'arabic' ? 'اجتماعي' : context.report.language === 'bilingual' ? 'اجتماعي / social' : 'social',
        consideration: localizeTemplateText('Continuity of cultural identity and public value', 'استمرارية الهوية الثقافية والقيمة المجتمعية', context.report.language),
        projectResponse: localizeTemplateText('Protect heritage character and align reuse with community interpretation and access.', 'حماية الشخصية التراثية وربط إعادة الاستخدام بالتفسير المجتمعي وإمكانية الوصول.', context.report.language),
      },
      {
        dimension: context.report.language === 'arabic' ? 'اقتصادي' : context.report.language === 'bilingual' ? 'اقتصادي / economic' : 'economic',
        consideration: localizeTemplateText('Long-term viability of adaptive reuse', 'الجدوى طويلة الأمد لإعادة الاستخدام التكيفي', context.report.language),
        projectResponse: localizeTemplateText('Phase implementation and align interventions with maintainable operations.', 'تنفيذ المشروع على مراحل وربط التدخلات بقدرة تشغيلية قابلة للاستدامة والصيانة.', context.report.language),
      },
    ],
    implementationRecommendations: [
      {
        phase: localizeTemplateText('Documentation and verification', 'التوثيق والتحقق', context.report.language),
        priority: context.report.language === 'arabic' ? 'عالٍ' : context.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
        recommendation: localizeTemplateText('Complete archival, measured, and photographic documentation before major intervention.', 'استكمال التوثيق الأرشيفي والمساحي والتصويري قبل أي تدخل رئيسي.', context.report.language),
        deliverable: localizeTemplateText('Verified base dossier and condition register', 'ملف أساس موثق وسجل حالة معتمد', context.report.language),
      },
      {
        phase: localizeTemplateText('Design development', 'تطوير التصميم', context.report.language),
        priority: context.report.language === 'arabic' ? 'عالٍ' : context.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
        recommendation: localizeTemplateText('Translate the rehabilitation strategy into phased, significance-led intervention packages.', 'تحويل استراتيجية التأهيل إلى حزم تدخل مرحلية موجّهة بالقيمة التراثية.', context.report.language),
        deliverable: localizeTemplateText('Coordinated rehabilitation design package', 'حزمة تصميم تأهيل منسقة', context.report.language),
      },
      {
        phase: localizeTemplateText('Delivery and monitoring', 'التنفيذ والمتابعة', context.report.language),
        priority: context.report.language === 'arabic' ? 'متوسط' : context.report.language === 'bilingual' ? 'متوسط / medium' : 'medium',
        recommendation: localizeTemplateText('Establish maintenance and post-occupancy monitoring criteria.', 'وضع معايير للصيانة والمتابعة بعد التشغيل أو الإشغال.', context.report.language),
        deliverable: localizeTemplateText('Maintenance and performance monitoring plan', 'خطة صيانة ومتابعة أداء', context.report.language),
      },
    ],
    references: context.standards.map(item => ({
      title: item.title,
      year: item.year,
      note: item.note,
    })),
    appendixSuggestions: [
      localizeTemplateText('Comparative visual reference outputs', 'مخرجات مرجعية للمقارنة البصرية', context.report.language),
      localizeTemplateText('Architectural visualization sheets', 'لوحات التصور المعماري', context.report.language),
      localizeTemplateText('Geospatial maps and urban context outputs', 'خرائط ومخرجات السياق الجغرافي والعمراني', context.report.language),
      localizeTemplateText('Condition photo log and intervention schedule', 'سجل الصور الحالة وجدول التدخلات', context.report.language),
    ],
  };
}

function buildTemplateReport(context) {
  const localizedContext = localizedContextView(context);
  const labels = getStaticLabels(localizedContext.report.language);
  const project = localizedContext.project;
  const reportType = normalizeReportType(localizedContext.report.type);
  const templateMeta = buildTemplateReportMeta(localizedContext);
  const title = `${project.buildingName} - ${getReportTypeLabelLocalized(reportType, localizedContext.report.language)}`;
  const service1 = localizedContext.linkedServices.service1;
  const service2 = localizedContext.linkedServices.service2;
  const service3 = localizedContext.linkedServices.service3;
  const sectionBodies = buildTemplateSectionBodies(localizedContext, service1, service2, service3);

  const sections = localizedContext.sections.map(section => ({
    id: section.id,
    title: section.title,
    body: sectionBodies[section.id] || 'Section content was not available.',
    keyPoints: [],
  }));

  const implementationRecommendations = reportType === 'feasibility'
    ? [
      {
        phase: localizeTemplateText('Technical due diligence', 'التحقق الفني التفصيلي', localizedContext.report.language),
        priority: localizedContext.report.language === 'arabic' ? 'عالٍ' : localizedContext.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
        recommendation: localizeTemplateText('Undertake structural, material, and services investigations before committing to delivery scope.', 'تنفيذ فحوص إنشائية ومادية وخدمية قبل اعتماد نطاق التنفيذ النهائي.', localizedContext.report.language),
        deliverable: localizeTemplateText('Technical feasibility dossier', 'ملف جدوى فنية تفصيلي', localizedContext.report.language),
      },
      {
        phase: localizeTemplateText('Cost and operating model', 'نموذج التكلفة والتشغيل', localizedContext.report.language),
        priority: localizedContext.report.language === 'arabic' ? 'عالٍ' : localizedContext.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
        recommendation: localizeTemplateText('Prepare a phased cost plan, operating assumptions, and affordability test for the proposed use.', 'إعداد خطة تكاليف مرحلية وافتراضات تشغيلية واختبار قدرة مالية للاستخدام المقترح.', localizedContext.report.language),
        deliverable: localizeTemplateText('Phased financial and operational model', 'نموذج مالي وتشغيلي مرحلي', localizedContext.report.language),
      },
      {
        phase: localizeTemplateText('Risk governance', 'حوكمة المخاطر', localizedContext.report.language),
        priority: localizedContext.report.language === 'arabic' ? 'متوسط' : localizedContext.report.language === 'bilingual' ? 'متوسط / medium' : 'medium',
        recommendation: localizeTemplateText('Establish approvals, contingencies, and risk ownership before procurement and execution.', 'تحديد مسارات الاعتماد والاحتياطيات ومسؤوليات المخاطر قبل الطرح والتنفيذ.', localizedContext.report.language),
        deliverable: localizeTemplateText('Risk register and implementation governance plan', 'سجل مخاطر وخطة حوكمة تنفيذ', localizedContext.report.language),
      },
    ]
    : reportType === 'academic'
      ? [
        {
          phase: localizeTemplateText('Evidence verification', 'التحقق من الأدلة', localizedContext.report.language),
          priority: localizedContext.report.language === 'arabic' ? 'عالٍ' : localizedContext.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
          recommendation: localizeTemplateText('Expand archival and field verification to strengthen the research claims of the study.', 'توسيع التحقق الأرشيفي والميداني لتعزيز الحجج البحثية الواردة في الدراسة.', localizedContext.report.language),
          deliverable: localizeTemplateText('Verified research appendix', 'ملحق بحثي موثق', localizedContext.report.language),
        },
        {
          phase: localizeTemplateText('Analytical development', 'تطوير التحليل', localizedContext.report.language),
          priority: localizedContext.report.language === 'arabic' ? 'متوسط' : localizedContext.report.language === 'bilingual' ? 'متوسط / medium' : 'medium',
          recommendation: localizeTemplateText('Deepen the comparative and methodological discussion with additional references and measured evidence.', 'تعميق المناقشة المقارنة والمنهجية بمراجع إضافية وأدلة قياسية وميدانية.', localizedContext.report.language),
          deliverable: localizeTemplateText('Expanded analytical chapter set', 'فصول تحليلية موسعة', localizedContext.report.language),
        },
      ]
      : [
        {
          phase: localizeTemplateText('Documentation completion', 'استكمال التوثيق', localizedContext.report.language),
          priority: localizedContext.report.language === 'arabic' ? 'عالٍ' : localizedContext.report.language === 'bilingual' ? 'عالٍ / high' : 'high',
          recommendation: localizeTemplateText('Complete archival, measured, and photographic documentation before any major intervention decision.', 'استكمال التوثيق الأرشيفي والمساحي والتصويري قبل اتخاذ أي قرار تدخلي رئيسي.', localizedContext.report.language),
          deliverable: localizeTemplateText('Integrated documentation dossier', 'ملف توثيقي متكامل', localizedContext.report.language),
        },
        {
          phase: localizeTemplateText('Conservation verification', 'التحقق الحفظي', localizedContext.report.language),
          priority: localizedContext.report.language === 'arabic' ? 'متوسط' : localizedContext.report.language === 'bilingual' ? 'متوسط / medium' : 'medium',
          recommendation: localizeTemplateText('Verify undocumented alterations and condition anomalies through specialist review.', 'التحقق من التحولات غير الموثقة ومظاهر التدهور عبر مراجعة تخصصية.', localizedContext.report.language),
          deliverable: localizeTemplateText('Conservation observation register', 'سجل ملاحظات حفظية', localizedContext.report.language),
        },
      ];

  return {
    title,
    executiveSummary: templateMeta.executiveSummary,
    abstract: templateMeta.abstract,
    keywords: templateMeta.keywords || labels.keywords,
    sections,
    standardsChecklist: localizedContext.standards.map(item => ({
      framework: item.code,
      principle: item.title,
      application: item.scope,
      status: localizedContext.report.language === 'arabic' ? 'قيد التحقق' : localizedContext.report.language === 'bilingual' ? 'قيد التحقق / pending verification' : 'pending verification',
    })),
    sustainabilityMatrix: [
      {
        dimension: localizedContext.report.language === 'arabic' ? 'بيئي' : localizedContext.report.language === 'bilingual' ? 'بيئي / environmental' : 'environmental',
        consideration: localizeTemplateText('Retention of embodied material value', 'الحفاظ على القيمة الكامنة في المواد والكتلة البنائية', localizedContext.report.language),
        projectResponse: localizeTemplateText('Prioritize repair, selective replacement, and low-impact material strategies.', 'إعطاء الأولوية للإصلاح والاستبدال الانتقائي واستراتيجيات المواد منخفضة الأثر.', localizedContext.report.language),
      },
      {
        dimension: localizedContext.report.language === 'arabic' ? 'اجتماعي' : localizedContext.report.language === 'bilingual' ? 'اجتماعي / social' : 'social',
        consideration: localizeTemplateText('Continuity of cultural identity and public value', 'استمرارية الهوية الثقافية والقيمة المجتمعية', localizedContext.report.language),
        projectResponse: localizeTemplateText('Protect heritage character and align reuse with community interpretation and access.', 'حماية الشخصية التراثية وربط إعادة الاستخدام بالتفسير المجتمعي وإمكانية الوصول.', localizedContext.report.language),
      },
      {
        dimension: localizedContext.report.language === 'arabic' ? 'اقتصادي' : localizedContext.report.language === 'bilingual' ? 'اقتصادي / economic' : 'economic',
        consideration: localizeTemplateText('Long-term viability of adaptive reuse', 'الجدوى طويلة الأمد لإعادة الاستخدام التكيفي', localizedContext.report.language),
        projectResponse: localizeTemplateText('Phase implementation and align interventions with maintainable operations.', 'تنفيذ المشروع على مراحل وربط التدخلات بقدرة تشغيلية قابلة للاستدامة والصيانة.', localizedContext.report.language),
      },
    ],
    implementationRecommendations,
    references: localizedContext.standards.map(item => ({
      title: item.title,
      year: item.year,
      note: item.note,
    })),
    appendixSuggestions: [
      localizeTemplateText('Comparative visual reference outputs', 'مخرجات مرجعية للمقارنة البصرية', localizedContext.report.language),
      localizeTemplateText('Architectural visualization sheets', 'لوحات التصور المعماري', localizedContext.report.language),
      localizeTemplateText('Geospatial maps and urban context outputs', 'خرائط ومخرجات السياق الجغرافي والعمراني', localizedContext.report.language),
      localizeTemplateText('Condition photo log and intervention schedule', 'سجل صور الحالة وجدول التدخلات', localizedContext.report.language),
    ],
  };
}

function ensureReportShape(report, context) {
  const localizedContext = localizedContextView(context);
  const labels = getStaticLabels(context.report.language);
  const templateReport = buildTemplateReport(localizedContext);
  const sections = Array.isArray(report.sections) && report.sections.length
    ? report.sections
    : templateReport.sections;
  const isEnglish = context.report.language === 'english';
  const isArabic = context.report.language === 'arabic';
  const normalizeSingleLine = (value, fallback) => {
    const normalized = normalizeText(value, fallback);
    const cleaned = isEnglish || isArabic
      ? sanitizeValueForLanguage(
        normalized,
        context.report.language,
        fallback,
        isEnglish ? { strictEnglish: true } : { strictArabic: true },
      )
      : normalized;
    return neutralizeServiceMentions(cleaned, context.report.language);
  };
  const normalizeMultiLine = (value, fallback) => {
    const normalized = normalizeMultiline(value, fallback);
    const cleaned = isEnglish || isArabic
      ? sanitizeMultilineForLanguage(
        normalized,
        context.report.language,
        fallback,
        isEnglish ? { strictEnglish: true } : { strictArabic: true },
      )
      : normalized;
    return neutralizeServiceMentions(cleaned, context.report.language);
  };
  const normalizeStringList = (values, fallback = []) => {
    const source = Array.isArray(values) && values.length ? values : fallback;
    const normalized = Array.isArray(source) ? source.map(value => normalizeText(value)).filter(Boolean) : [];
    const localized = normalized.map(value => neutralizeServiceMentions(value, context.report.language));
    if (isArabic) {
      const sanitized = localized.filter(value => !shouldFallbackArabicText(value, { strictArabic: true }));
      return sanitized.length ? sanitized : fallback.map(value => neutralizeServiceMentions(value, context.report.language));
    }
    if (!isEnglish) return localized;
    const sanitized = localized.filter(value => !containsArabic(value));
    return sanitized.length ? sanitized : fallback.map(value => neutralizeServiceMentions(value, context.report.language));
  };

  return {
    title: normalizeSingleLine(report.title, templateReport.title),
    executiveSummary: normalizeMultiLine(report.executiveSummary, templateReport.executiveSummary || labels.notGeneratedSummary),
    abstract: normalizeMultiLine(report.abstract, templateReport.abstract || labels.notGeneratedAbstract),
    keywords: Array.isArray(report.keywords) && report.keywords.length
      ? normalizeStringList(report.keywords, templateReport.keywords || labels.keywords)
      : templateReport.keywords || labels.keywords,
    sections: sections.map((section, index) => ({
      id: normalizeText(section.id, context.sections[index]?.id || `section_${index + 1}`),
      title: normalizeSingleLine(
        section.title,
        templateReport.sections[index]?.title || localizedContext.sections[index]?.title || getSectionTitle(section.id, context.report.language),
      ),
      body: normalizeMultiLine(section.body, templateReport.sections[index]?.body || labels.noNarrative),
      keyPoints: normalizeStringList(section.keyPoints, templateReport.sections[index]?.keyPoints || []),
    })),
    standardsChecklist: (Array.isArray(report.standardsChecklist) ? report.standardsChecklist : templateReport.standardsChecklist || []).map((item, index) => ({
      framework: normalizeSingleLine(item.framework, templateReport.standardsChecklist[index]?.framework || ''),
      principle: normalizeSingleLine(item.principle, templateReport.standardsChecklist[index]?.principle || ''),
      application: normalizeMultiLine(item.application, templateReport.standardsChecklist[index]?.application || ''),
      status: normalizeSingleLine(item.status, templateReport.standardsChecklist[index]?.status || ''),
    })),
    sustainabilityMatrix: (Array.isArray(report.sustainabilityMatrix) ? report.sustainabilityMatrix : templateReport.sustainabilityMatrix || []).map((item, index) => ({
      dimension: normalizeSingleLine(item.dimension, templateReport.sustainabilityMatrix[index]?.dimension || ''),
      consideration: normalizeSingleLine(item.consideration, templateReport.sustainabilityMatrix[index]?.consideration || ''),
      projectResponse: normalizeMultiLine(item.projectResponse, templateReport.sustainabilityMatrix[index]?.projectResponse || ''),
    })),
    implementationRecommendations: (Array.isArray(report.implementationRecommendations) ? report.implementationRecommendations : templateReport.implementationRecommendations || []).map((item, index) => ({
      phase: normalizeSingleLine(item.phase, templateReport.implementationRecommendations[index]?.phase || ''),
      priority: normalizeSingleLine(item.priority, templateReport.implementationRecommendations[index]?.priority || ''),
      recommendation: normalizeMultiLine(item.recommendation, templateReport.implementationRecommendations[index]?.recommendation || ''),
      deliverable: normalizeSingleLine(item.deliverable, templateReport.implementationRecommendations[index]?.deliverable || ''),
    })),
    references: (Array.isArray(report.references) ? report.references : templateReport.references || []).map((item, index) => ({
      title: normalizeSingleLine(item.title, templateReport.references[index]?.title || ''),
      year: normalizeSingleLine(item.year, templateReport.references[index]?.year || ''),
      note: normalizeMultiLine(item.note, templateReport.references[index]?.note || ''),
    })),
    appendixSuggestions: normalizeStringList(report.appendixSuggestions, templateReport.appendixSuggestions || []),
  };
}

const SERVICE_04_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'executiveSummary', 'abstract', 'keywords', 'sections', 'implementationRecommendations', 'references', 'appendixSuggestions'],
  properties: {
    title: { type: 'string' },
    executiveSummary: { type: 'string' },
    abstract: { type: 'string' },
    keywords: {
      type: 'array',
      items: { type: 'string' },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'body', 'keyPoints'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          keyPoints: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    implementationRecommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phase', 'priority', 'recommendation', 'deliverable'],
        properties: {
          phase: { type: 'string' },
          priority: { type: 'string' },
          recommendation: { type: 'string' },
          deliverable: { type: 'string' },
        },
      },
    },
    references: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'year', 'note'],
        properties: {
          title: { type: 'string' },
          year: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    appendixSuggestions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
};
const SERVICE_04_MODEL_OVERRIDES = {
  gpt: process.env.SERVICE_04_OPENAI_MODEL || process.env.OPENAI_REPORT_MODEL || 'openai/gpt-5',
  gemini: process.env.SERVICE_04_GEMINI_MODEL || process.env.GEMINI_REPORT_MODEL || 'google/gemini-3.1-pro',
  claude: process.env.SERVICE_04_CLAUDE_MODEL || process.env.CLAUDE_REPORT_MODEL || 'anthropic/claude-4.5-sonnet',
};

async function synthesizeReport(context) {
  const promptConfig = buildService4PromptConfig(context.promptConfig || {});
  const { systemPrompt, userPrompt } = buildPromptBundle(context, promptConfig);
  const result = await generateStructuredJson({
    aiModel: context.report.aiModel,
    systemPrompt,
    userPrompt,
    parseJson: parseJsonResponse,
    modelOverrides: SERVICE_04_MODEL_OVERRIDES,
    temperature: 0.3,
    maxTokens: 4500,
    timeoutMs: 180000,
    jsonSchema: SERVICE_04_JSON_SCHEMA,
  });

  if (!reportMatchesRequestedLanguage(result.json, context.report.language)) {
    throw new Error(`Generated report did not match requested language: ${context.report.language}.`);
  }

  return {
    aiModel: context.report.aiModel,
    aiModelLabel: context.report.aiModelLabel,
    provider: result.provider,
    model: result.model,
    report: ensureReportShape(result.json, context),
    prompts: { systemPrompt, userPrompt },
    warnings: [],
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

  const exportContext = localizedContextView(context);
  const labels = getStaticLabels(exportContext.report.language);
  const rtlLike = exportContext.report.language === 'arabic' || exportContext.report.language === 'bilingual';
  const primaryAlign = rtlLike ? AlignmentType.RIGHT : AlignmentType.LEFT;

  const children = [
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${getReportTypeLabelLocalized(exportContext.report.type, exportContext.report.language)} | `, bold: true }),
        new TextRun(`${REPORT_MODE_LABELS[exportContext.report.mode] || exportContext.report.mode}`),
      ],
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${labels.location}: `, bold: true }),
        new TextRun(exportContext.project.location),
      ],
      alignment: primaryAlign,
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `${labels.generated}: `, bold: true }),
        new TextRun(new Date().toLocaleString()),
      ],
      alignment: primaryAlign,
    }),
    new Paragraph({ text: '' }),
    new Paragraph({
      text: labels.executiveSummary,
      heading: HeadingLevel.HEADING_1,
      alignment: primaryAlign,
    }),
    new Paragraph({ text: report.executiveSummary, alignment: primaryAlign }),
    new Paragraph({
      text: labels.abstract,
      heading: HeadingLevel.HEADING_1,
      alignment: primaryAlign,
    }),
    new Paragraph({ text: report.abstract, alignment: primaryAlign }),
  ];

  for (const section of report.sections) {
    children.push(
      new Paragraph({
        text: section.title,
        heading: HeadingLevel.HEADING_1,
        alignment: primaryAlign,
      }),
      new Paragraph({ text: section.body, alignment: primaryAlign }),
    );

    if (section.keyPoints.length) {
      for (const point of section.keyPoints) {
        children.push(new Paragraph({ text: `• ${point}`, alignment: primaryAlign }));
      }
    }
  }

  if (report.standardsChecklist.length) {
    children.push(new Paragraph({ text: labels.standardsMatrix, heading: HeadingLevel.HEADING_1, alignment: primaryAlign }));
    for (const item of report.standardsChecklist) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${item.framework}: `, bold: true }),
          new TextRun(`${item.principle} | ${item.status}`),
        ],
        alignment: primaryAlign,
      }));
      children.push(new Paragraph({ text: item.application || '', alignment: primaryAlign }));
    }
  }

  if (report.implementationRecommendations.length) {
    children.push(new Paragraph({ text: labels.implementationRecommendations, heading: HeadingLevel.HEADING_1, alignment: primaryAlign }));
    for (const item of report.implementationRecommendations) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${item.phase} (${item.priority})`, bold: true }),
        ],
        alignment: primaryAlign,
      }));
      children.push(new Paragraph({ text: `${item.recommendation}${rtlLike ? ' | ' : ' Deliverable: '}${item.deliverable}`, alignment: primaryAlign }));
    }
  }

  if (report.references.length) {
    children.push(new Paragraph({ text: labels.references, heading: HeadingLevel.HEADING_1, alignment: primaryAlign }));
    for (const ref of report.references) {
      children.push(new Paragraph({ text: `${ref.title} (${ref.year}). ${ref.note}`, alignment: primaryAlign }));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
}

async function buildPdfReport(report, context, images, outPath) {
  return new Promise((resolve, reject) => {
    const exportContext = localizedContextView(context);
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    const labels = getStaticLabels(exportContext.report.language);
    const rtlLike = exportContext.report.language === 'arabic' || exportContext.report.language === 'bilingual';
    const align = rtlLike ? 'right' : 'left';
    const pageBottom = () => doc.page.height - doc.page.margins.bottom - 20;
    const ensureSpace = (minHeight = 48) => {
      if (doc.y + minHeight > pageBottom()) doc.addPage();
    };

    setPdfFont(doc, true).fontSize(20).text(formatPdfText(report.title, exportContext.report.language), { align: 'center' });
    doc.moveDown(0.5);
    setPdfFont(doc, false).fontSize(10).text(
      formatPdfText(`${getReportTypeLabelLocalized(exportContext.report.type, exportContext.report.language)} | ${REPORT_MODE_LABELS[exportContext.report.mode] || exportContext.report.mode}`, exportContext.report.language),
      { align: 'center' },
    );
    doc.text(formatPdfText(`${exportContext.project.location} | ${new Date().toLocaleString()}`, exportContext.report.language), { align: 'center' });
    doc.moveDown(1);

    if (images[0] && fs.existsSync(images[0].path)) {
      try {
        doc.image(images[0].path, { fit: [515, 220], align: 'center' });
        doc.moveDown(0.5);
      } catch (error) {
        // Ignore image rendering issues and continue with text.
      }
    }

    ensureSpace(60);
    setPdfFont(doc, true).fontSize(14).text(formatPdfText(labels.executiveSummary, exportContext.report.language), { align });
    doc.moveDown(0.3);
    setPdfFont(doc, false).fontSize(10).text(formatPdfText(report.executiveSummary, exportContext.report.language), { align: rtlLike ? 'right' : 'justify' });
    doc.moveDown(0.8);

    for (const section of report.sections) {
      ensureSpace(56);
      setPdfFont(doc, true).fontSize(13).text(formatPdfText(section.title, exportContext.report.language), { align });
      doc.moveDown(0.25);
      setPdfFont(doc, false).fontSize(10).text(formatPdfText(section.body, exportContext.report.language), { align: rtlLike ? 'right' : 'justify' });
      doc.moveDown(0.5);

      for (const point of section.keyPoints || []) {
        ensureSpace(24);
        setPdfFont(doc, false).fontSize(9).text(formatPdfText(`• ${point}`, exportContext.report.language), { indent: 12, align });
      }

      doc.moveDown(0.8);
    }

    if (report.references.length) {
      ensureSpace(56);
      setPdfFont(doc, true).fontSize(13).text(formatPdfText(labels.references, exportContext.report.language), { align });
      doc.moveDown(0.3);
      for (const ref of report.references) {
        ensureSpace(26);
        setPdfFont(doc, false).fontSize(9).text(formatPdfText(`${ref.title} (${ref.year}) - ${ref.note}`, exportContext.report.language), { align });
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      const footerY = doc.page.height - doc.page.margins.bottom - 12;
      setPdfFont(doc, false).fontSize(8).text(
        `Page ${i + 1} of ${range.count}`,
        40,
        footerY,
        { align: 'center', width: doc.page.width - 80 },
      );
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildExcelReport(report, context, linkedJobs, outPath) {
  const exportContext = localizedContextView(context);
  const evidenceJobs = exportContext.report.language === 'english'
    ? linkedJobs.map(job => (job.service === 2
      ? localizedService2View(job, exportContext.report.language)
      : job.service === 3
        ? localizedService3View(job, exportContext.report.language)
        : { ...job }))
    : linkedJobs;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = SERVICE_04_NAME;
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Project Summary');
  summary.columns = [{ width: 28 }, { width: 60 }];
  summary.addRow(['Field', 'Value']).font = { bold: true };
  [
    ['Building name', exportContext.project.buildingName],
    ['Location', exportContext.project.location],
    ['Approximate date', exportContext.project.approximateDate],
    ['Current condition', exportContext.project.currentCondition],
    ['Architectural style', exportContext.project.architecturalStyle],
    ['Target function', exportContext.project.targetFunction],
    ['Report type', REPORT_TYPE_LABELS[exportContext.report.type] || exportContext.report.type],
    ['Report mode', REPORT_MODE_LABELS[exportContext.report.mode] || exportContext.report.mode],
    ['Language', LANGUAGE_LABELS[exportContext.report.language] || exportContext.report.language],
    ['Depth', DEPTH_LABELS[exportContext.report.depth] || exportContext.report.depth],
  ].forEach(row => summary.addRow(row));

  const evidence = workbook.addWorksheet('Evidence Register');
  evidence.columns = [
    { header: 'Source', key: 'source', width: 18 },
    { header: 'Reference', key: 'reference', width: 28 },
    { header: 'Summary', key: 'summary', width: 80 },
  ];
  evidenceJobs.forEach(job => {
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

router.get('/prompt-config', (_req, res) => {
  res.json({
    success: true,
    defaults: buildService4PromptConfig(),
    placeholders: [
      '[REPORT_MODE_LABEL]',
      '[REPORT_TYPE_LABEL]',
      '[REPORT_TYPE_UI_LABEL]',
      '[LANGUAGE_INSTRUCTION]',
      '[DEPTH_REQUIREMENT]',
      '[TONE]',
      '[MODE_TONE]',
      '[OBJECTIVE]',
      '[EMPHASIS]',
      '[JSON_SCHEMA]',
      '[PROJECT_CONTEXT_JSON]',
    ],
  });
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
    try {
      context.promptConfig = parseService4PromptConfig(req.body?.promptConfig);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const synthesis = await synthesizeReport(context);
    const report = synthesis.report;
    const exportContext = localizedContextView(context);
    const selectedReportLabel = context.report.typeLabel || getReportTypeUiLabel(context.report.type);
    const localizedReportLabel = getReportTypeLabelLocalized(context.report.type, context.report.language);

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
        typeLabel: selectedReportLabel,
        mode: context.report.mode,
        language: context.report.language,
        depth: context.report.depth,
        standardProfile: context.report.standardsProfile,
        aiModel: context.report.aiModelLabel,
        aiModelKey: context.report.aiModel,
      },
      promptConfig: context.promptConfig,
      prompts: synthesis.prompts,
      project: exportContext.project,
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
      { label: `${localizedReportLabel} (Word)`, url: relOutputUrl(jobId, docxPath), ext: 'docx' },
      { label: `${localizedReportLabel} (PDF)`, url: relOutputUrl(jobId, pdfPath), ext: 'pdf' },
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


