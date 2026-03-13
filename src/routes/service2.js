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
  Document, Packer, Paragraph, TextRun, HeadingLevel,
} = require('docx');
const PDFDocument = require('pdfkit');
const ExcelJS    = require('exceljs');
const DxfWriter  = require('dxf-writer');

const router    = express.Router();
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

const SERVICE_02_NAME = 'Architectural Rehabilitation Visualization';
const SERVICE_02_DEFINITION = 'Generate high-quality architectural rehabilitation visuals for an existing building based on reference images and project details. The service restores, enhances, or adaptively reuses heritage and traditional buildings while preserving their architectural identity, proportions, facade details, and heritage value. Outputs should be realistic, presentation-ready, architecturally coherent, and clearly connected to the original structure rather than an unrelated redesign.';
const DEFAULT_VIEW_COUNT = 8;
const RASTER_REFERENCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp']);
const DOCUMENT_REFERENCE_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx']);

function summarizeReferenceInputs(files = []) {
  const summary = {
    totalFiles: files.length,
    rasterImages: 0,
    documents: 0,
    unsupported: 0,
    fileNames: [],
    rasterImagePaths: [],
  };

  for (const file of files) {
    const originalName = file.originalname || path.basename(file.path || '');
    const ext = path.extname(originalName).toLowerCase();

    summary.fileNames.push(originalName);

    if (RASTER_REFERENCE_EXTENSIONS.has(ext)) {
      summary.rasterImages += 1;
      if (file.path) summary.rasterImagePaths.push(file.path);
      continue;
    }

    if (DOCUMENT_REFERENCE_EXTENSIONS.has(ext)) {
      summary.documents += 1;
      continue;
    }

    summary.unsupported += 1;
  }

  return summary;
}

function validateReferenceFiles(files = []) {
  for (const file of files) {
    const ext = path.extname(file.originalname || file.path || '').toLowerCase();
    const size = file.size || 0;

    if (RASTER_REFERENCE_EXTENSIONS.has(ext) && size > 50 * 1024 * 1024) {
      return `Image file "${file.originalname}" exceeds the 50 MB limit.`;
    }

    if (DOCUMENT_REFERENCE_EXTENSIONS.has(ext) && size > 100 * 1024 * 1024) {
      return `Document file "${file.originalname}" exceeds the 100 MB limit.`;
    }
  }

  return null;
}

function getFloorCount(floors) {
  return Math.max(parseInt(floors, 10) || 1, 1);
}

function deriveMaterialPalette(styleKey, styleAnalysis) {
  const defaults = {
    'Ù†Ø¬Ø¯ÙŠ': ['mud brick', 'lime plaster', 'palm wood', 'carved gypsum'],
    'Ø­Ø¬Ø§Ø²ÙŠ': ['coral stone', 'limestone', 'painted timber', 'mashrabiya woodwork'],
    'Ø¹Ø³ÙŠØ±ÙŠ': ['stone masonry', 'juniper wood', 'lime render', 'painted geometric finishes'],
    'Ù…Ø¹Ø§ØµØ± Ø¨Ù‡ÙˆÙŠØ© ØªØ±Ø§Ø«ÙŠØ©': ['stone cladding', 'terracotta', 'timber screens', 'lime-based finishes'],
  };

  const base = defaults[styleKey] || ['stone', 'lime plaster', 'timber', 'traditional decorative finishes'];
  const detected = (styleAnalysis?.elements || []).slice(0, 4);
  return [...new Set([...detected, ...base])].slice(0, 6);
}

function getStyleLabel(styleKey) {
  return {
    'Ù†Ø¬Ø¯ÙŠ': 'Najdi',
    'Ø­Ø¬Ø§Ø²ÙŠ': 'Hejazi',
    'Ø¹Ø³ÙŠØ±ÙŠ': 'Asiri',
    'Ù…Ø¹Ø§ØµØ± Ø¨Ù‡ÙˆÙŠØ© ØªØ±Ø§Ø«ÙŠØ©': 'Contemporary heritage',
  }[styleKey] || 'traditional';
}

function getFunctionLabel(funcKey) {
  return FUNCTION_LABELS[funcKey] || funcKey || 'adaptive reuse destination';
}


// ── Storage ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── Helper: download URL to file ──────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════
// STEP 2 — GPT-4o on Replicate: Architectural Style Analysis from reference images
// ══════════════════════════════════════════════════════════════════
async function analyzeStyleWithGPT4o(imagePaths, style, buildingType) {
  const rasterPaths = (imagePaths || []).filter(p =>
    RASTER_REFERENCE_EXTENSIONS.has(path.extname(p).toLowerCase())
  );

  if (rasterPaths.length === 0) {
    return {
      detectedStyle: style,
      confidence: 'N/A',
      elements: [],
      heritageValue: 'Undocumented',
      notes: 'No raster reference images were provided. Visual generation will rely on the project brief and any uploaded documents as supporting context.',
      reuseGuidance: 'Preserve the building identity, proportions, facade rhythm, materials, and significant heritage details.',
    };
  }

  console.log(`[GPT-4o/Replicate] Analyzing ${rasterPaths.length} raster reference image(s) for rehabilitation context...`);

  // Convert local image files to base64 data URIs for Replicate
  const imageInputs = rasterPaths.slice(0, 3).map(p => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: 'You are an expert architectural heritage rehabilitation analyst. Identify the original architectural character of an existing building and explain what should be preserved during rehabilitation or adaptive reuse. Always respond with valid JSON only.',
      prompt: `Analyze these reference images of a building.
Identify:
1) The building's architectural character and style
2) The key visible elements that define its identity (massing, facade rhythm, materials, openings, ornaments, roofline, structural cues)
3) The heritage value and rehabilitation potential
4) Guidance for adaptive reuse while preserving the original character

User selected style: ${style}. Building function: ${buildingType}.

Return ONLY this JSON structure, no other text:
{ "detectedStyle": "...", "confidence": "High/Medium/Low", "elements": ["..."], "heritageValue": "...", "notes": "...", "reuseGuidance": "..." }`,
      image_input: imageInputs,
      max_completion_tokens: 400,
      temperature: 0.2,
    },
  });

  try {
    const text = Array.isArray(output) ? output.join('') : String(output);
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const result = JSON.parse(json);
      console.log(`[GPT-4o] ✓ Detected: ${result.detectedStyle} (${result.confidence} confidence)`);
      return result;
    }
    return { detectedStyle: style, confidence: 'N/A', notes: text.substring(0, 200) };
  } catch {
    return { detectedStyle: style, confidence: 'N/A', notes: 'Parse error' };
  }
}

// ══════════════════════════════════════════════════════════════════
// STEP 3 — GPT-4o on Replicate: Craft custom SDXL prompt from building data
// ══════════════════════════════════════════════════════════════════
async function engineerPromptWithGPT4o(style, buildingType, area, floors, specialReqs, buildingName, viewLabel, styleAnalysis) {
  const context = [
    buildingName ? `Building: ${buildingName}` : '',
    `Style: ${style}`,
    `Function: ${buildingType}`,
    area   ? `Area: ${area} m²` : '',
    floors ? `Floors: ${floors}` : '',
    specialReqs ? `Special: ${specialReqs}` : '',
    styleAnalysis?.elements?.length ? `Detected elements: ${styleAnalysis.elements.join(', ')}` : '',
  ].filter(Boolean).join(', ');

  console.log(`[GPT-4o/Replicate] Engineering prompt for: ${viewLabel}...`);

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: 'You are an expert Stable Diffusion XL prompt engineer specializing in Saudi heritage architecture. Write highly detailed, photorealistic, architecturally precise prompts. Return ONLY the prompt text, no explanations.',
      prompt: `Write a Stable Diffusion XL prompt for the "${viewLabel}" view of a rehabilitated Saudi heritage building.

Project context: ${context}

Requirements:
- Start with "Traditional ${style} architecture rehabilitation as ${buildingType}"
- Include authentic architectural details (materials, patterns, construction techniques)
- Include the view angle: ${viewLabel}
- End with: natural lighting, Saudi Arabia, architectural photography, highly detailed, 8K
- Maximum 200 words. Return only the prompt, no explanation.`,
      max_completion_tokens: 250,
      temperature: 0.7,
    },
  });

  const engineeredPrompt = (Array.isArray(output) ? output.join('') : String(output)).trim();
  console.log(`[GPT-4o] ✓ Prompt ready (${engineeredPrompt.length} chars)`);
  return engineeredPrompt;
}

// ══════════════════════════════════════════════════════════════════════════
// DXF Floor Plan Generator (AutoCAD-compatible via dxf-writer)
// ══════════════════════════════════════════════════════════════════════════
async function engineerRehabilitationPromptWithGPT4o(style, buildingType, area, floors, specialReqs, buildingName, viewLabel, styleAnalysis) {
  const context = [
    buildingName ? `Building: ${buildingName}` : '',
    `Style intent: ${style}`,
    `Proposed use: ${buildingType}`,
    area ? `Area: ${area} mÂ²` : '',
    floors ? `Floors: ${floors}` : '',
    specialReqs ? `Special requirements: ${specialReqs}` : '',
    styleAnalysis?.elements?.length ? `Heritage-defining elements: ${styleAnalysis.elements.join(', ')}` : '',
    styleAnalysis?.heritageValue ? `Heritage value: ${styleAnalysis.heritageValue}` : '',
    styleAnalysis?.reuseGuidance ? `Reuse guidance: ${styleAnalysis.reuseGuidance}` : '',
    styleAnalysis?.notes ? `Assessment notes: ${styleAnalysis.notes}` : '',
  ].filter(Boolean).join(', ');

  console.log(`[GPT-4o/Replicate] Engineering rehab prompt for: ${viewLabel}...`);

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: 'You are an expert architectural rehabilitation visualizer and Stable Diffusion XL prompt engineer. Write highly detailed, photorealistic prompts for rehabilitation or adaptive reuse of heritage and traditional buildings. The result must preserve the original building identity and look like a credible rehabilitation vision, not a replacement design. Return ONLY the prompt text, with no explanation.',
      prompt: `Write a Stable Diffusion XL prompt for the "${viewLabel}" view of an architectural rehabilitation project for an existing heritage or traditional building.

Project context: ${context}

Requirements:
- Start with "Architectural rehabilitation visualization of a ${getStyleLabel(style)} heritage building adapted as ${getFunctionLabel(buildingType)}"
- Preserve the original massing, facade rhythm, proportions, openings, and visible heritage details
- Include authentic materials, textures, decorative details, and construction cues appropriate to the reference building
- Show a realistic adaptive reuse outcome aligned with the proposed function
- Include the view angle: ${viewLabel}
- End with: architectural rehabilitation visualization, photorealistic, presentation render, highly detailed
- Maximum 220 words. Return only the prompt, no explanation.`,
      max_completion_tokens: 250,
      temperature: 0.7,
    },
  });

  const engineeredPrompt = (Array.isArray(output) ? output.join('') : String(output)).trim();
  console.log(`[GPT-4o] âœ“ Rehab prompt ready (${engineeredPrompt.length} chars)`);
  return engineeredPrompt;
}

function buildDxf(area, floors, funcKey, buildingName, dxfPath) {
  const d = new DxfWriter();
  d.setUnits('Meters');

  // Calculate dimensions from area (rough square-ish floor plate)
  const totalArea = parseFloat(area) || 500;
  const numFloors = parseInt(floors)  || 2;
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));  // width
  const H = Math.ceil(floorArea / W);               // depth

  // ── Layers ───────────────────────────────────────────────────────────
  d.addLayer('WALLS',      DxfWriter.ACI.WHITE,    'CONTINUOUS');
  d.addLayer('ROOMS',      DxfWriter.ACI.CYAN,     'CONTINUOUS');
  d.addLayer('DIMENSIONS', DxfWriter.ACI.YELLOW,   'CONTINUOUS');
  d.addLayer('TEXT',       DxfWriter.ACI.GREEN,    'CONTINUOUS');
  d.addLayer('GRID',       DxfWriter.ACI.GRAY,     'DASHED');

  // ── Outer walls ───────────────────────────────────────────────────────
  d.setActiveLayer('WALLS');
  const t = 0.3; // wall thickness
  d.drawRect(0, 0, W, H);

  // ── Room layout based on function ─────────────────────────────────────
  d.setActiveLayer('ROOMS');
  const rooms = generateRooms(funcKey, W, H, t);
  for (const r of rooms) {
    d.drawRect(r.x, r.y, r.x + r.w, r.y + r.h);
  }

  // ── Text labels ───────────────────────────────────────────────────────
  d.setActiveLayer('TEXT');
  const title = (buildingName || funcKey).replace(/[^\x00-\x7F]/g, '').trim() || 'Heritage Building';
  d.drawText(W/2, H + 2, 0.8, 0, `GROUND FLOOR PLAN - ${title.toUpperCase()}`);
  d.drawText(W/2, H + 1, 0.5, 0, `Total Floor Area: ${floorArea.toFixed(0)} m2  |  Floors: ${numFloors}`);
  for (const r of rooms) {
    const label = r.label.replace(/[^\x00-\x7F]/g, '?').trim();
    d.drawText(r.x + r.w/2, r.y + r.h/2, 0.3, 0, label);
  }

  // ── Dimensions ────────────────────────────────────────────────────────
  d.setActiveLayer('DIMENSIONS');
  d.drawText(W/2, -1.5, 0.4, 0, `Width: ${W.toFixed(1)} m`);
  d.drawText(-3,  H/2,  0.4, 90, `Depth: ${H.toFixed(1)} m`);

  fs.writeFileSync(dxfPath, d.toDxfString());
}

function generateRooms(funcKey, W, H, t) {
  // Generic room layouts by function
  const layouts = {
    'متحف':       ['Main Hall','Gallery A','Gallery B','Reception','Storage','Restrooms','Staff Room','Utility'],
    'مركز زوار':  ['Reception','Exhibition','Visitor Lounge','Cafe','Shop','Restrooms','Office','Storage'],
    'مسكن':       ['Majlis','Living Room','Master Bedroom','Bedroom 2','Bedroom 3','Kitchen','Dining','Bathroom'],
    'معرض':       ['Main Gallery','Gallery 2','Reception','Storage','Office','Restrooms','Lounge','Utility'],
    'مطعم':       ['Dining Hall','Private Dining','Kitchen','Prep Area','Storage','Restrooms','Reception','Staff'],
    'مكتبة':      ['Main Reading','Archive','Study Rooms','Children','Reception','Staff Room','Storage','Restrooms'],
  };
  const names = layouts[funcKey] || layouts['متحف'];
  const rooms = [];
  const cols = 2, rows = Math.ceil(names.length / cols);
  const rW = (W - t * (cols+1)) / cols;
  const rH = (H - t * (rows+1)) / rows;
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (i >= names.length) break;
      rooms.push({ x: t + c*(rW+t), y: t + r*(rH+t), w: rW, h: rH, label: names[i] });
      i++;
    }
  }
  return rooms;
}

// ══════════════════════════════════════════════════════════════════════════
// SVG Floor Plan Generator (visual, browser-friendly)
// ══════════════════════════════════════════════════════════════════════════
function buildSvgFloorPlan(area, floors, funcKey, buildingName, svgPath) {
  const totalArea = parseFloat(area) || 500;
  const numFloors = parseInt(floors)  || 2;
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));
  const H = Math.ceil(floorArea / W);

  const scale = 22;  // pixels per metre
  const pad   = 60;
  const svgW  = W * scale + pad * 2;
  const svgH  = H * scale + pad * 2 + 60;

  const rooms = generateRooms(funcKey, W, H, 0.3);
  const colors = ['#f0f4ff','#fff4e6','#f0fff4','#fdf0ff','#e6f7ff','#fffbe6','#f5f5f5','#fff0f0'];

  let roomsSvg = rooms.map((r, i) => {
    const rx = pad + r.x * scale, ry = pad + r.y * scale;
    const rw = r.w * scale,       rh = r.h * scale;
    const cx = rx + rw/2,         cy = ry + rh/2;
    return `
    <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}"
          fill="${colors[i % colors.length]}" stroke="#1a3554" stroke-width="1.5" rx="3"/>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="Arial" font-size="9" fill="#1a3554" font-weight="bold">${r.label}</text>
    <text x="${cx}" y="${cy + 9}" text-anchor="middle" font-family="Arial" font-size="7" fill="#666">${(r.w * r.h).toFixed(0)} m²</text>`;
  }).join('');

  const title = (buildingName || funcKey).replace(/[\u0600-\u06FF]/g, '').trim() || 'Heritage Building';
  const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="${svgW}" height="${svgH}" fill="#f8f9fa"/>
  <rect x="${pad}" y="${pad}" width="${W*scale}" height="${H*scale}"
        fill="white" stroke="#1a3554" stroke-width="3"/>
  ${roomsSvg}
  <text x="${svgW/2}" y="${svgH - 30}" text-anchor="middle" font-family="Arial" font-size="13" fill="#1a3554" font-weight="bold">
    GROUND FLOOR PLAN — ${title.toUpperCase()}</text>
  <text x="${svgW/2}" y="${svgH - 14}" text-anchor="middle" font-family="Arial" font-size="9" fill="#666">
    Floor Area: ${floorArea.toFixed(0)} m²  |  ${numFloors} Floor(s)  |  Building Width: ${W}m × Depth: ${H}m</text>
  <line x1="${pad}" y1="${pad + H*scale + 10}" x2="${pad + W*scale}" y2="${pad + H*scale + 10}" stroke="#1a3554" stroke-width="1"/>
  <text x="${pad + W*scale/2}" y="${pad + H*scale + 24}" text-anchor="middle" font-family="Arial" font-size="8" fill="#1a3554">${W} m</text>
</svg>`;
  fs.writeFileSync(svgPath, svgContent);
}

function buildFloorPlanPdf(area, floors, funcKey, buildingName, floorIndex, pdfPath) {
  const totalArea = parseFloat(area) || 500;
  const numFloors = getFloorCount(floors);
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));
  const H = Math.ceil(floorArea / W);
  const rooms = generateRooms(funcKey, W, H, 0.3);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const out = fs.createWriteStream(pdfPath);
    doc.pipe(out);

    const scale = Math.min(420 / W, 520 / H);
    const ox = 70;
    const oy = 110;

    doc.font('Helvetica-Bold').fontSize(16).text(`Floor Plan - Level ${floorIndex + 1}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(buildingName || 'Heritage Building', { align: 'center' });

    doc.rect(ox, oy, W * scale, H * scale).lineWidth(2).stroke('#1a3554');
    rooms.forEach((r, idx) => {
      const x = ox + r.x * scale;
      const y = oy + r.y * scale;
      const w = r.w * scale;
      const h = r.h * scale;
      doc.rect(x, y, w, h).lineWidth(1).fillAndStroke(['#f0f4ff', '#fff4e6', '#f0fff4', '#fff0f0'][idx % 4], '#1a3554');
      doc.fillColor('#1a3554').fontSize(8).text(r.label, x + 4, y + h / 2 - 6, { width: w - 8, align: 'center' });
    });

    doc.fillColor('#333333').fontSize(10).text(`Approx. area: ${floorArea.toFixed(0)} m2`, 40, 740);
    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

function buildSectionDxf(area, floors, buildingName, dxfPath) {
  const d = new DxfWriter();
  d.setUnits('Meters');
  d.addLayer('SECTION', DxfWriter.ACI.WHITE, 'CONTINUOUS');
  d.addLayer('TEXT', DxfWriter.ACI.GREEN, 'CONTINUOUS');
  d.setActiveLayer('SECTION');

  const totalArea = parseFloat(area) || 500;
  const numFloors = getFloorCount(floors);
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));
  const floorHeight = 4;

  for (let i = 0; i < numFloors; i++) {
    const y = i * floorHeight;
    d.drawRect(0, y, W, y + floorHeight);
    d.drawLine(0, y, W, y + floorHeight);
  }

  d.setActiveLayer('TEXT');
  d.drawText(W / 2, numFloors * floorHeight + 1.5, 0.8, 0, `SECTION A-A - ${(buildingName || 'Heritage Building').replace(/[^\x00-\x7F]/g, '').toUpperCase()}`);
  fs.writeFileSync(dxfPath, d.toDxfString());
}

function buildSectionSvg(area, floors, buildingName, svgPath) {
  const totalArea = parseFloat(area) || 500;
  const numFloors = getFloorCount(floors);
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));
  const floorHeight = 4;
  const scale = 28;
  const pad = 60;
  const svgW = W * scale + pad * 2;
  const svgH = numFloors * floorHeight * scale + pad * 2 + 50;

  let floorsSvg = '';
  for (let i = 0; i < numFloors; i++) {
    const y = svgH - pad - (i + 1) * floorHeight * scale;
    floorsSvg += `
    <rect x="${pad}" y="${y}" width="${W * scale}" height="${floorHeight * scale}" fill="#f8fafc" stroke="#1a3554" stroke-width="2"/>
    <line x1="${pad}" y1="${y}" x2="${pad + W * scale}" y2="${y + floorHeight * scale}" stroke="#d97706" stroke-width="1.5" stroke-dasharray="6 4"/>
    <text x="${pad + 12}" y="${y + 20}" font-family="Arial" font-size="12" fill="#1a3554">Level ${i + 1}</text>`;
  }

  const title = (buildingName || 'Heritage Building').replace(/[\u0600-\u06FF]/g, '').trim() || 'Heritage Building';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
  <rect width="${svgW}" height="${svgH}" fill="#ffffff"/>
  <text x="${svgW / 2}" y="36" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#1a3554">SECTION A-A</text>
  <text x="${svgW / 2}" y="56" text-anchor="middle" font-family="Arial" font-size="11" fill="#64748b">${title.toUpperCase()}</text>
  ${floorsSvg}
</svg>`;

  fs.writeFileSync(svgPath, svg);
}

function buildSectionPdf(area, floors, buildingName, pdfPath) {
  const totalArea = parseFloat(area) || 500;
  const numFloors = getFloorCount(floors);
  const floorArea = totalArea / numFloors;
  const W = Math.ceil(Math.sqrt(floorArea * 1.4));
  const floorHeight = 4;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const out = fs.createWriteStream(pdfPath);
    doc.pipe(out);

    const scale = Math.min(420 / W, 500 / (numFloors * floorHeight));
    const ox = 80;
    const baseY = 720;

    doc.font('Helvetica-Bold').fontSize(16).text('Section A-A', { align: 'center' });
    doc.font('Helvetica').fontSize(10).text(buildingName || 'Heritage Building', { align: 'center' });

    for (let i = 0; i < numFloors; i++) {
      const y = baseY - (i + 1) * floorHeight * scale;
      doc.rect(ox, y, W * scale, floorHeight * scale).lineWidth(1.5).stroke('#1a3554');
      doc.moveTo(ox, y).lineTo(ox + W * scale, y + floorHeight * scale).dash(6, { space: 4 }).stroke('#d97706').undash();
      doc.fontSize(10).fillColor('#1a3554').text(`Level ${i + 1}`, ox + 6, y + 10);
    }

    doc.end();
    out.on('finish', resolve);
    out.on('error', reject);
  });
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'));
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
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

async function buildPptx(results, buildingName, style, buildingType, pptxPath) {
  const imageEntries = [];
  const slideEntries = [];
  const slideRelEntries = [];
  const slideIdEntries = [];
  const presentationRelEntries = ['<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'];

  const allSlides = [
    {
      title: buildingName || SERVICE_02_NAME,
      subtitle: `${style} rehabilitation adapted as ${getFunctionLabel(buildingType)}`,
      imagePath: null,
      imageRelId: null,
    },
    ...results.map((result, index) => ({
      title: result.labelEn,
      subtitle: result.prompt || '',
      imagePath: result.pngPath,
      imageRelId: `rId2`,
      mediaName: `image${index + 1}.png`,
    })),
  ];

  allSlides.forEach((slide, index) => {
    const slideNo = index + 1;
    slideIdEntries.push(`<p:sldId id="${255 + slideNo}" r:id="rId${slideNo + 1}"/>`);
    presentationRelEntries.push(`<Relationship Id="rId${slideNo + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideNo}.xml"/>`);

    const title = xmlEscape(slide.title);
    const subtitle = xmlEscape(slide.subtitle);
    const pictureXml = slide.imagePath ? `
    <p:pic>
      <p:nvPicPr><p:cNvPr id="4" name="Picture ${slideNo}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${slide.imageRelId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="8229600" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
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
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400" b="1"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Subtitle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="457200" y="914400"/><a:ext cx="8229600" cy="342900"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1200"/><a:t>${subtitle}</a:t></a:r></a:p></p:txBody>
      </p:sp>${pictureXml}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
    });

    if (slide.imagePath) {
      imageEntries.push({ name: `ppt/media/${slide.mediaName}`, data: fs.readFileSync(slide.imagePath) });
      slideRelEntries.push({
        name: `ppt/slides/_rels/slide${slideNo}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="${slide.imageRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${slide.mediaName}"/>
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
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>
  <Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>
  <Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${allSlides.map((_, idx) => `<Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
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
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Codex</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${allSlides.length}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips></Properties>`,
    },
    {
      name: 'docProps/core.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(buildingName || SERVICE_02_NAME)}</dc:title><dc:creator>Codex</dc:creator><cp:lastModifiedBy>Codex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1" autoCompressPictures="0">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIdEntries.join('')}</p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presentationRelEntries.join('\n  ')}
  <Relationship Id="rId${allSlides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/>
  <Relationship Id="rId${allSlides.length + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/>
  <Relationship Id="rId${allSlides.length + 4}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/slideMasters/slideMaster1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles/>
</p:sldMaster>`,
    },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/slideLayouts/slideLayout1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
    },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
    },
    {
      name: 'ppt/theme/theme1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="1A3554"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1A3554"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="DFAF67"/></a:accent1><a:accent2><a:srgbClr val="38BDF8"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="10B981"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`,
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

  fs.writeFileSync(pptxPath, createStoredZip(entries));
}

// ══════════════════════════════════════════════════════════════════════════
// Excel Report Generator (room schedule + area table)
// ══════════════════════════════════════════════════════════════════════════
async function buildExcel(results, style, funcKey, area, floors, buildingName, xlsxPath) {
  const wb  = new ExcelJS.Workbook();
  wb.creator = SERVICE_02_NAME;
  wb.created = new Date();

  // ── Sheet 1: Project Summary ──────────────────────────────────────────
  const sum = wb.addWorksheet('Project Summary');
  sum.columns = [{ width: 28 }, { width: 40 }];
  const header = sum.addRow(['Architectural Rehabilitation Visualization Report']);
  header.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  header.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1521' } };
  sum.mergeCells('A1:B1');
  header.alignment = { horizontal: 'center' };
  sum.addRow([]);
  const fields = [
    ['Service',           SERVICE_02_NAME],
    ['Building Name',     buildingName || '—'],
    ['Architectural Style', style],
    ['Building Function', funcKey],
    ['Total Area',        `${area || '—'} m²`],
    ['Number of Floors',  floors || '—'],
    ['Views Generated',   `${results.length} views`],
    ['Generated At',      new Date().toLocaleString()],
    ['Model',             'stability-ai/sdxl (Expert Quality)'],
  ];
  for (const [k, v] of fields) {
    const row = sum.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F0FE' } };
  }

  // ── Sheet 2: Room Schedule (DXF-matched) ─────────────────────────────
  const sched = wb.addWorksheet('Room Schedule');
  sched.columns = [
    { header: 'Room No.', key: 'no',   width: 10 },
    { header: 'Room Name', key: 'name', width: 30 },
    { header: 'Floor',    key: 'floor', width: 10 },
    { header: 'Area (m²)',key: 'area',  width: 14 },
    { header: 'Function', key: 'fn',    width: 22 },
    { header: 'Notes',    key: 'notes', width: 30 },
  ];
  sched.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sched.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3554' } };

  const layouts = {
    'متحف':      ['Main Hall','Gallery A','Gallery B','Reception','Storage','Restrooms','Staff Room','Utility'],
    'مركز زوار': ['Reception','Exhibition','Visitor Lounge','Cafe','Shop','Restrooms','Office','Storage'],
    'مسكن':      ['Majlis','Living Room','Master Bedroom','Bedroom 2','Bedroom 3','Kitchen','Dining','Bathroom'],
    'معرض':      ['Main Gallery','Gallery 2','Reception','Storage','Office','Restrooms','Lounge','Utility'],
    'مطعم':      ['Dining Hall','Private Dining','Kitchen','Prep Area','Storage','Restrooms','Reception','Staff'],
    'مكتبة':     ['Main Reading','Archive','Study Rooms','Children','Reception','Staff Room','Storage','Restrooms'],
  };
  const rooms = layouts[funcKey] || layouts['متحف'];
  const floorArea = (parseFloat(area) || 500) / (parseInt(floors) || 2);
  const perRoom   = floorArea / rooms.length;
  let totalArea   = 0;
  for (let i = 0; i < rooms.length; i++) {
    const rArea = parseFloat((perRoom * (0.8 + Math.random() * 0.4)).toFixed(1));
    totalArea  += rArea;
    sched.addRow({ no: i+1, name: rooms[i], floor: 'Ground', area: rArea, fn: funcKey, notes: '' });
  }
  const totalRow = sched.addRow({ no: '', name: 'TOTAL', floor: '', area: totalArea.toFixed(1), fn: '', notes: '' });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };

  // ── Sheet 3: Views Generated ──────────────────────────────────────────
  const views = wb.addWorksheet('Generated Views');
  views.columns = [
    { header: 'No.',      key: 'no',     width: 6  },
    { header: 'View',     key: 'view',   width: 28 },
    { header: 'English',  key: 'en',     width: 28 },
    { header: 'Aspect',   key: 'aspect', width: 10 },
  ];
  views.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  views.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A3554' } };
  for (const [i, r] of results.entries()) {
    views.addRow({ no: i+1, view: r.labelAr, en: r.labelEn,
      aspect: r.width > r.height ? '16:9' : '3:4' });
  }

  await wb.xlsx.writeFile(xlsxPath);
}


// Format: "Traditional [X] architecture rehabilitation as [function],
//          [style details], [view], natural lighting, [name] Saudi Arabia,
//          architectural photography, highly detailed, 8K"
const STYLE_DETAILS = {
  'نجدي':               'authentic mud brick construction, triangular crenellations, rammed earth qasr towers, narrow slit windows, carved gypsum geometric patterns, reddish-brown earthen tones, palm wood ceilings, interior courtyard, Saudi Najd heritage',
  'حجازي':              'authentic coral stone and limestone construction, Rawasheen wooden latticework bay windows, ornate carved wooden balconies, mashrabiya screens, white plastered walls, multi-story facade, decorative calligraphy, Hejaz coastal heritage',
  'عسيري':              'authentic slate stone and juniper wood construction, colorful geometric painted bands on exterior walls, red yellow and black tribal motifs, distinctive ornamental window frames, multi-story terraced structure, Aseer highlands heritage',
  'معاصر بهوية تراثية': 'contemporary interpretation with heritage identity, modern mashrabiya parametric facade, terracotta and white stone cladding, sustainable design principles, fusion of traditional patterns with modern architecture, NEOM-inspired quality',
};

const FUNCTION_LABELS = {
  'متحف':        'museum',
  'مركز زوار':   'visitor center',
  'مسكن':        'residential heritage villa',
  'معرض':        'art gallery',
  'مطعم':        'heritage restaurant',
  'مكتبة':       'library',
  'أخرى':        'adaptive reuse heritage building',
};

// ── 8 view definitions ────────────────────────────────────────────────────
// Each view defines: label (Arabic), viewPrompt, aspect (16:9 or 3:4), w, h
const STYLE_PROMPT_GUIDANCE = {
  'Najdi': 'If the selected style is Najdi, emphasize mud-brick character, geometric openings, thick walls, and restrained traditional Najdi detailing.',
  'Hejazi': 'If the selected style is Hejazi, emphasize roshan-inspired wooden elements, urban heritage facade articulation, and refined decorative screens.',
  'Asiri': 'If the selected style is Asiri, emphasize stone or painted decorative character, regional material identity, and mountainous heritage expression where appropriate.',
  'Contemporary heritage': 'If the selected style is Contemporary with heritage identity, preserve traditional references while introducing refined contemporary rehabilitation in a balanced and respectful way.',
};

const VIEW_PROMPT_TEMPLATES = {
  front: "Generate the FRONT facade view of the heritage building in [ARCHITECTURAL_STYLE] style. Show a clear main entrance composition with a frontal architectural perspective. Preserve the original facade identity, symmetry where appropriate, decorative elements, material character, and style-specific details. Make the facade elegant, realistic, and suitable for adaptive reuse as [PROPOSED_USE]. Make the scene lively and inhabited with subtle human activity. Include a few visitors near the entrance, soft landscape elements, potted plants, palms or style-appropriate planting, and refined outdoor details. Add movement and life, but keep the composition uncluttered and architecturally readable. This must be a true front facade architectural visualization, not an aerial view, not an interior, and not a side elevation.",
  rear: "Generate the REAR facade of the heritage building in [ARCHITECTURAL_STYLE] style. This must be a true back-side architectural view, not a front facade. Make the composition simpler and less ceremonial than the front elevation. Avoid a grand main entrance, avoid overly formal symmetry, and show realistic secondary rear treatment with back openings, service-side architectural details, and reduced ornamentation while still preserving the selected architectural style. Make the scene lively and inhabited with subtle human presence, garden elements, potted plants, palms or context-appropriate greenery, and realistic outdoor life. Add a few people naturally using the rear space, but keep the image calm and elegant. The rear facade should still feel active and visually appealing without looking like the main public entrance. Do not generate another front facade. The requested output must clearly represent the back side of the building.",
  right: "Generate the RIGHT SIDE elevation of the heritage building in [ARCHITECTURAL_STYLE] style. This must be a true right-side architectural facade, not a front-facing view. Show the building from the right side with believable side-wall composition, side openings, depth, massing, and secondary facade details that remain consistent with the selected architectural language. Make the scene lively and inhabited. Include a few people walking or standing naturally, soft greenery, potted plants, palm trees or context-appropriate landscape elements, and refined outdoor details. Add realistic signs of use and daily life while keeping the right-side facade clearly visible and readable. Do not generate another front facade. The requested output must clearly represent the right side of the building.",
  left: "Generate the LEFT SIDE elevation of the heritage building in [ARCHITECTURAL_STYLE] style. This must be a true left-side architectural facade, not a front-facing view. Show the side massing, side windows, realistic wall depth, and coherent secondary architectural details that match the selected heritage design language. Make the scene lively, inhabited, and visually rich in a subtle way. Include a few people, potted plants, palm trees or context-appropriate vegetation, and soft outdoor environmental details. The human presence should feel natural and calm, and the greenery should support the scene without overpowering the architecture. Do not generate another front facade. The requested output must clearly represent the left side of the building.",
  aerial: "Generate an AERIAL architectural view of the heritage building in [ARCHITECTURAL_STYLE] style from an oblique bird's-eye perspective. Show the overall building massing, roofscape, courtyard organization, upper-level details, and spatial layout clearly. Preserve the style-specific character, proportions, materials, and decorative language. Make the image lively and inhabited. Add subtle human presence in courtyards or surrounding areas, soft landscape features, palms or style-appropriate vegetation, potted plants, and realistic environmental context. The scene should feel alive and believable while keeping the architecture as the main visual focus. This must be a true aerial architectural visualization, not a front facade and not an interior view.",
  interior: "Generate a realistic INTERIOR architectural view of the heritage building in [ARCHITECTURAL_STYLE] style, such as a courtyard, hall, or ceremonial interior space. Preserve arches, carved details, ceilings, traditional proportions, ornamental surfaces, and authentic material character according to the selected architectural style. Make the interior feel lively and inhabited. Include a few people interacting naturally in the space, along with indoor plants, courtyard greenery, soft decorative elements, and subtle signs of use. The atmosphere should feel warm, elegant, active, and believable without becoming crowded. This must be a true interior architectural visualization, not a floor plan, not a facade, and not an aerial view.",
  night: "Generate a NIGHT architectural view of the heritage building in [ARCHITECTURAL_STYLE] style with warm, elegant lighting that highlights the facade details, openings, ornamental character, and material textures. Preserve the architectural identity of the selected style while creating a refined and presentation-ready nighttime atmosphere. Make the scene lively and inhabited. Include a few people, subtle night-time activity, palm trees or style-appropriate planting, potted plants, and realistic outdoor context. The building should feel active and welcoming at night, with balanced lighting and visible human life, but without overcrowding the image. This must be a true night view with believable evening atmosphere and architectural lighting.",
  floorplan: "Generate a true 2D top-down architectural floor plan of a heritage building. The output must be a real floor plan viewed directly from above, not an interior perspective, not an aerial rendering, not a facade, and not a 3D scene. Clearly show walls, room layout, doors, circulation paths, courtyard organization, entrances, and spatial relationships. The plan should be readable, structured, and professionally composed like an architectural drawing. Reflect the selected architectural style in the spatial organization and plan logic. If the style is Najdi, use thick walls, courtyard-based layout, and restrained traditional organization. If the style is Hejazi, reflect urban heritage house planning, inner courtyard logic, and elegant room distribution. If the style is Aseeri, reflect regional spatial character and mountain-context planning where appropriate. If the style is Contemporary with heritage identity, preserve traditional references while introducing refined contemporary planning logic. Make the floor plan visually rich and lively in a presentation-friendly way without turning it into a perspective scene. Add subtle architectural presentation elements such as labeled spaces, furniture blocks, courtyard planting, trees or planters in open areas, water features if appropriate, and small human scale indicators from top view only. Keep these details clean, minimal, and organized so the drawing remains clear and readable. Use a clean top-down architectural representation with refined linework, balanced composition, realistic heritage planning logic, and strong graphic clarity. Do not generate perspective depth, shadows of a 3D render, eye-level interior views, exterior facades, or oblique aerial views. The final result must look like a true architectural floor plan from above.",
  street: "Generate a human-scale STREET PERSPECTIVE of the heritage building in [ARCHITECTURAL_STYLE] style from pedestrian eye level. Show the arrival experience, facade depth, entrance approach, and surrounding urban context clearly while preserving the original architectural identity. Make the scene lively and inhabited with subtle human activity, soft greenery, potted plants, and style-appropriate landscape details. The image should feel realistic, elegant, and presentation-ready while keeping the architecture as the main subject. This must be a true street-level architectural visualization, not an aerial view, not an interior, and not a facade-only elevation.",
  detail: "Generate a close-up FACADE DETAIL visualization of the heritage building in [ARCHITECTURAL_STYLE] style. Focus on craftsmanship, material texture, ornamental patterns, openings, screens, carvings, or decorative elements that define the building character. Preserve the original material authenticity and restoration quality while keeping the image realistic and presentation-ready. Add only subtle contextual life cues if visible, but keep the architectural detail as the clear focus. This must be a true architectural detail view, not a full facade, not an aerial view, and not an interior scene.",
  adaptive_reuse: "Generate a realistic ADAPTIVE REUSE INTERIOR view of the heritage building in [ARCHITECTURAL_STYLE] style for use as [PROPOSED_USE]. Show how the original shell, arches, materials, and heritage details are preserved while the new use is inserted in a balanced, elegant, and believable way. Make the interior feel active and inhabited with a few people, subtle furnishings, soft planting, and refined presentation quality. The result must feel architecturally coherent, respectful of the original structure, and clearly suitable for the proposed new use. This must be a true interior adaptive reuse visualization, not a facade, not an aerial view, and not a floor plan.",
  sectional: "Generate an architectural SECTIONAL PERSPECTIVE of the heritage building in [ARCHITECTURAL_STYLE] style. Show the building envelope, interior spatial hierarchy, floor-to-floor relationships, courtyard or hall organization, and adaptive reuse logic clearly. Preserve heritage character, material identity, and style-specific details while presenting the cut-through view in a refined architectural way. Keep the image presentation-ready, believable, and clearly readable as a sectional architectural visualization rather than a standard exterior render.",
};

const VIEWS = [
  {
    id: 'front',
    labelAr: 'الواجهة الأمامية',
    labelEn: 'Front Facade',
    view: 'front elevation, symmetrical facade, main entrance, centered composition, architectural photography',
    width: 768, height: 1024,   // 3:4 portrait (both ÷8) ✓
  },
  {
    id: 'rear',
    labelAr: 'الواجهة الخلفية',
    labelEn: 'Rear Facade',
    view: 'rear elevation, back facade, service entrance, architectural drawing perspective',
    width: 768, height: 1024,
  },
  {
    id: 'left',
    labelAr: 'الواجهة اليسرى',
    labelEn: 'Left Side Facade',
    view: 'left side elevation, lateral facade view, architectural photography',
    width: 768, height: 1024,
  },
  {
    id: 'right',
    labelAr: 'الواجهة اليمنى',
    labelEn: 'Right Side Facade',
    view: 'right side elevation, lateral facade view, architectural photography',
    width: 768, height: 1024,

  },
  {
    id: 'aerial',
    labelAr: 'المنظور الهوائي',
    labelEn: 'Aerial View',
    view: 'bird\'s eye aerial view, drone shot, full building rooftop and surroundings, wide angle landscape',
    width: 1344, height: 768,    // 16:9 landscape
  },
  {
    id: 'interior',
    labelAr: 'الفناء الداخلي',
    labelEn: 'Interior Courtyard',
    view: 'interior courtyard view, central atrium, ornamental garden, looking upward, warm ambient light, indoor architectural photography',
    width: 1344, height: 768,
  },
  {
    id: 'floorplan',
    labelAr: 'المسقط الأفقي',
    labelEn: 'Ground Floor Plan',
    view: 'architectural floor plan drawing, top-down plan view, room layout, walls doors windows labeled, clean technical drawing style, black and white blueprint aesthetic',
    width: 1344, height: 768,
  },
  {
    id: 'night',
    labelAr: 'المنظور الليلي',
    labelEn: 'Night View',
    view: 'night exterior view, dramatic architectural lighting, warm amber spotlights on facade, dark blue sky, reflective ground, golden glow, wide shot',
    width: 1344, height: 768,
  },
  {
    id: 'street',
    labelAr: 'Ø§Ù„Ù…Ø´Ù‡Ø¯ Ø§Ù„Ø§Ù†Ø³Ø§Ù†ÙŠ',
    labelEn: 'Street Perspective',
    view: 'human-scale street perspective, entrance sequence, preserved facade character, surrounding context, realistic pedestrian eye-level architectural photography',
    width: 1344, height: 768,
  },
  {
    id: 'detail',
    labelAr: 'Ø§Ù„ØªÙØµÙŠÙ„ Ø§Ù„ØªØ±Ø§Ø«ÙŠ',
    labelEn: 'Facade Detail Close-Up',
    view: 'close-up facade detail, preserved ornament, material texture, craftsmanship, window surrounds, architectural macro photography',
    width: 768, height: 1024,
  },
  {
    id: 'adaptive_reuse',
    labelAr: 'Ø¯Ø§Ø®Ù„ Ù…Ø¹Ø§Ø¯ Ø§Ù„ØªØ£Ù‡ÙŠÙ„',
    labelEn: 'Adaptive Reuse Interior',
    view: 'interior adaptive reuse perspective, restored shell with contemporary function inserted respectfully, authentic materials, realistic furniture and lighting, architectural interior photography',
    width: 1344, height: 768,
  },
  {
    id: 'sectional',
    labelAr: 'Ù…Ù‚Ø·Ø¹ Ù…Ø¹Ù…Ø§Ø±ÙŠ',
    labelEn: 'Sectional Perspective',
    view: 'architectural sectional perspective, restored building envelope, interior spatial hierarchy, adaptive reuse program, realistic materials, presentation board quality',
    width: 1344, height: 768,
  },
];

// ── Craft SDXL prompt — matches user's exact template ────────────────────
// "Traditional [Style] architecture rehabilitation as [function],
//  [style details], [view], [area/floors/extras], natural lighting,
//  [name] Saudi Arabia, architectural photography, highly detailed, 8K"
function buildPrompt(view, styleKey, funcKey, area, floors, extra, buildingName) {
  // Style label for the opening sentence
  const styleLabel = {
    'نجدي': 'Najdi', 'حجازي': 'Hejazi',
    'عسيري': 'Asiri', 'معاصر بهوية تراثية': 'Contemporary Saudi Heritage',
  }[styleKey] || 'Saudi';

  const funcLabel   = FUNCTION_LABELS[funcKey]   || 'heritage building';
  const styleDetail = STYLE_DETAILS[styleKey]    || STYLE_DETAILS['نجدي'];
  const areaStr     = area   ? `, approximately ${area} m² total floor area` : '';
  const flrStr      = floors ? `, ${floors}-story building` : '';
  const extraPart   = extra  ? `, ${extra}` : '';
  const namePart    = buildingName ? `${buildingName}, ` : '';

  return (
    `${namePart}Traditional ${styleLabel} architecture rehabilitation as ${funcLabel}, ` +
    `${styleDetail}, ` +
    `${view.view}` +
    `${areaStr}${flrStr}${extraPart}, ` +
    `modern interior adaptation, natural lighting, Saudi Arabia, ` +
    `architectural photography, highly detailed, 8K`
  ).replace(/,\s*,/g, ',').trim();
}

function buildRehabilitationPrompt(view, styleKey, funcKey, area, floors, extra, buildingName) {
  const styleLabel  = getStyleLabel(styleKey);
  const funcLabel   = getFunctionLabel(funcKey);
  const styleDetail = STYLE_DETAILS[styleKey] || STYLE_DETAILS['Ù†Ø¬Ø¯ÙŠ'];
  const areaStr     = area ? `, approximately ${area} mÂ² total floor area` : '';
  const flrStr      = floors ? `, ${floors}-story building` : '';
  const extraPart   = extra ? `, ${extra}` : '';
  const namePart    = buildingName ? `${buildingName}, ` : '';

  return (
    `${namePart}Architectural rehabilitation visualization of a ${styleLabel} heritage building adapted as ${funcLabel}, ` +
    `preserve the original massing, facade rhythm, openings, and heritage-defining details, ` +
    `${styleDetail}, ` +
    `${view.view}` +
    `${areaStr}${flrStr}${extraPart}, ` +
    `credible adaptive reuse, realistic materials, photorealistic presentation render, ` +
    `architectural rehabilitation visualization, highly detailed`
  ).replace(/,\s*,/g, ',').trim();
}

function buildStableRehabilitationPrompt(view, styleKey, funcKey, area, floors, extra, buildingName, styleAnalysis) {
  const styleLabel = getStyleLabel(styleKey);
  const funcLabel = getFunctionLabel(funcKey);
  const styleDetail = STYLE_DETAILS[styleKey] || '';
  const styleGuidance = STYLE_PROMPT_GUIDANCE[styleLabel] || '';
  const referenceElements = styleAnalysis?.elements?.length
    ? `Use reference-informed cues such as ${styleAnalysis.elements.join(', ')} to keep the rehabilitation visually connected to the original building.`
    : '';
  const requestedView = ({
    front: 'FRONT',
    rear: 'REAR',
    left: 'LEFT SIDE',
    right: 'RIGHT SIDE',
    aerial: 'AERIAL',
    interior: 'INTERIOR',
    night: 'NIGHT',
    floorplan: 'FLOOR PLAN',
    street: 'STREET PERSPECTIVE',
    detail: 'FACADE DETAIL',
    adaptive_reuse: 'ADAPTIVE REUSE INTERIOR',
    sectional: 'SECTIONAL PERSPECTIVE',
  })[view.id] || String(view.labelEn || view.id || 'VIEW').toUpperCase();
  const projectFacts = [
    buildingName ? `Project name: ${buildingName}.` : '',
    funcLabel ? `Proposed use: ${funcLabel}.` : '',
    area ? `Approximate area: ${area} m2.` : '',
    floors ? `Proposed floors: ${floors}.` : '',
    extra ? `Additional project requirements: ${extra}.` : '',
  ].filter(Boolean).join(' ');
  const basePrompt = [
    `Generate a realistic architectural rehabilitation output for a heritage building adapted for contemporary use as ${funcLabel} while preserving its original identity.`,
    `The selected architectural style is ${styleLabel}.`,
    'The design must clearly reflect the visual language, material character, proportions, decorative treatment, and architectural identity of the selected style.',
    `The requested output view is ${requestedView}.`,
    'You must generate only the requested view type and not any other view.',
    'View control rules:',
    '- If the requested view is FRONT, generate a true front facade with the main entrance composition and principal architectural identity.',
    '- If the requested view is REAR, generate a true back facade. It must look like the rear side of the building, with simpler composition, reduced ceremonial emphasis, secondary openings, and no main public entrance. Do not generate another front facade.',
    '- If the requested view is LEFT SIDE, generate a true left-side architectural elevation. Show the building from the left side with visible side massing, side-wall composition, depth, and believable secondary facade treatment. Do not generate another front facade.',
    '- If the requested view is RIGHT SIDE, generate a true right-side architectural elevation. Show the building from the right side with visible side massing, side-wall composition, depth, and believable secondary facade treatment. Do not generate another front facade.',
    '- If the requested view is AERIAL, generate a true oblique bird\'s-eye view showing the overall massing, roofscape, courtyard organization, and spatial layout from above.',
    '- If the requested view is INTERIOR, generate a true interior architectural view such as a courtyard, hall, or internal heritage space. Do not generate a facade or aerial image.',
    '- If the requested view is NIGHT, generate a true night architectural view with evening atmosphere and warm architectural lighting.',
    '- If the requested view is FLOOR PLAN, generate a true 2D top-down architectural floor plan only. It must be flat, drawn from above, and clearly show walls, room layout, doors, circulation, courtyard organization, and spatial relationships. Do not generate an interior render, do not generate an aerial view, do not generate a facade, and do not generate any 3D scene or perspective image.',
    'Strict output constraints:',
    '- Do not confuse side views with front views.',
    '- Do not generate a decorative front facade when REAR, LEFT SIDE, or RIGHT SIDE is requested.',
    '- Do not generate an interior or aerial image when FLOOR PLAN is requested.',
    '- Do not generate a floor plan when a facade, aerial, interior, or night view is requested.',
    '- Do not generate multiple view types in one image.',
    '- The image must clearly and unambiguously match the requested view only.',
    'Stylistic and heritage constraints:',
    '- Preserve the heritage character of the building.',
    '- Keep the architecture realistic, coherent, and presentation-ready.',
    '- Use appropriate traditional materials, ornamental details, openings, and facade rhythm according to the selected style.',
    '- Avoid fantasy elements, avoid unrelated modern forms, avoid excessive glass, and avoid exaggerated ornamentation that breaks authenticity.',
    'Liveliness and atmosphere:',
    '- Make the scene feel lively and inhabited in a subtle, elegant, and realistic way.',
    '- Include a few people, soft greenery, potted plants, palm trees or region-appropriate vegetation, and calm contextual activity where appropriate.',
    '- Keep the architecture as the main focus.',
    '- Do not overcrowd the image.',
    '- If the requested view is FLOOR PLAN, make it visually rich in a flat architectural way only by using furniture blocks, courtyard planting, labels or top-view scale figures if appropriate, while keeping it strictly top-down and readable.',
    'Quality goal:',
    `Create a professional, high-quality, architecturally believable output that clearly matches the requested view: ${requestedView}, while preserving heritage identity and adding subtle life and realism.`,
    'Any output that does not exactly match the requested view type is incorrect and must be rejected.',
  ].join(' ');
  const viewPrompt = (VIEW_PROMPT_TEMPLATES[view.id] || view.view || '')
    .replace(/\[ARCHITECTURAL_STYLE\]/g, styleLabel)
    .replace(/\[PROPOSED_USE\]/g, funcLabel);

  return [
    basePrompt,
    styleGuidance,
    styleDetail ? `Material and character cues: ${styleDetail}.` : '',
    referenceElements,
    viewPrompt,
    projectFacts,
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function engineerRehabilitationPromptWithGPT4o(style, buildingType, area, floors, specialReqs, buildingName, viewLabel, styleAnalysis) {
  const matchedView = VIEWS.find(v => v.labelEn === viewLabel) || { id: 'front', view: viewLabel };
  const engineeredPrompt = buildStableRehabilitationPrompt(
    matchedView, style, buildingType, area, floors, specialReqs, buildingName, styleAnalysis
  );
  console.log(`[Prompt Builder] Using stable rehab prompt for: ${viewLabel}`);
  return engineeredPrompt;
}

const NEGATIVE_PROMPT =
  'blurry, low quality, distorted, cartoon, sketch, anime, ugly, deformed, ' +
  'complete redesign, unrelated new building, demolition, futuristic tower, flat design, ' +
  'watermark, text overlay, overexposed, underexposed, noise, artifacts';

// ── PDF builder ───────────────────────────────────────────────────────────
async function buildPdf(views, pdfPath, title) {
  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
    const out  = fs.createWriteStream(pdfPath);
    doc.pipe(out);

    const safeTitle = (title || 'Architectural Visualization Report').replace(/[\u0600-\u06FF]/g, '').trim() || 'Architectural Visualization Report';
    doc.fontSize(18).font('Helvetica-Bold').text(safeTitle, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(new Date().toISOString().split('T')[0], { align: 'center' });
    doc.moveDown(1);

    for (const [i, v] of views.entries()) {
      if (!v.pngPath || !fs.existsSync(v.pngPath)) continue;
      doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold').text(`View ${i+1}: ${v.labelEn}`, { align: 'left' });
      doc.fontSize(9).font('Helvetica').fillColor('#888888').text(v.view || '', { align: 'left' });
      doc.fillColor('#000000').moveDown(0.4);

      doc.moveDown(0.4);
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

// ── Word builder ──────────────────────────────────────────────────────────
async function buildWord(views, styleKey, funcKey, area, floors, extra, buildingName, docxPath) {
  const children = [
    new Paragraph({ text: 'تقرير التصور المعماري', heading: HeadingLevel.HEADING_1, alignment: 'center' }),
    new Paragraph({ text: `التاريخ: ${new Date().toLocaleDateString('ar-SA')}`, alignment: 'right' }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'معلومات المشروع', heading: HeadingLevel.HEADING_2 }),
    ...[
      ['اسم المنشأة', buildingName || '—'],
      ['الوظيفة', funcKey || '—'],
      ['النمط المعماري', styleKey || '—'],
      ['المساحة التقريبية', area ? `${area} م²` : '—'],
      ['عدد الطوابق', floors || '—'],
      ['متطلبات خاصة', extra || '—'],
    ].map(([label, val]) =>
      new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun({ text: String(val) })] })
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'التصورات المولّدة', heading: HeadingLevel.HEADING_2 }),
    ...views.map(v =>
      new Paragraph({ children: [new TextRun({ text: `✓ ${v.labelAr} (${v.labelEn})`, bold: true })] })
    ),
  ];

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buf);
}

// ══════════════════════════════════════════════════════════════════════════
async function buildRehabilitationWord(views, styleKey, funcKey, area, floors, extra, buildingName, styleAnalysis, referenceSummary, docxPath) {
  const preservationFocus = styleAnalysis?.elements?.length
    ? `Retain and reinterpret the defining character of the building through: ${styleAnalysis.elements.join(', ')}.`
    : 'Retain the building identity, overall proportions, facade details, heritage value, and visible character while adapting it to the proposed use.';
  const materials = deriveMaterialPalette(styleKey, styleAnalysis);

  const children = [
    new Paragraph({ text: 'ØªÙ‚Ø±ÙŠØ± Ø§Ù„ØªØµÙˆØ± Ø§Ù„Ù…Ø¹Ù…Ø§Ø±ÙŠ', heading: HeadingLevel.HEADING_1, alignment: 'center' }),
    new Paragraph({ text: `Ø§Ù„ØªØ§Ø±ÙŠØ®: ${new Date().toLocaleDateString('ar-SA')}`, alignment: 'right' }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'Ù…Ø¹Ù„ÙˆÙ…Ø§Øª Ø§Ù„Ù…Ø´Ø±ÙˆØ¹', heading: HeadingLevel.HEADING_2 }),
    ...[
      ['Ø§Ø³Ù… Ø§Ù„Ù…Ù†Ø´Ø£Ø©', buildingName || 'â€”'],
      ['Ø§Ù„ÙˆØ¸ÙŠÙØ©', funcKey || 'â€”'],
      ['Ø§Ù„Ù†Ù…Ø· Ø§Ù„Ù…Ø¹Ù…Ø§Ø±ÙŠ', styleKey || 'â€”'],
      ['Ø§Ù„Ù…Ø³Ø§Ø­Ø© Ø§Ù„ØªÙ‚Ø±ÙŠØ¨ÙŠØ©', area ? `${area} Ù…Â²` : 'â€”'],
      ['Ø¹Ø¯Ø¯ Ø§Ù„Ø·ÙˆØ§Ø¨Ù‚', floors || 'â€”'],
      ['Ù…ØªØ·Ù„Ø¨Ø§Øª Ø®Ø§ØµØ©', extra || 'â€”'],
    ].map(([label, val]) =>
      new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true }), new TextRun({ text: String(val) })] })
    ),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'Functional Definition', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: SERVICE_02_DEFINITION }),
    new Paragraph({ text: 'Reference Inputs', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: `Uploaded references: ${referenceSummary?.totalFiles || 0} file(s), including ${referenceSummary?.rasterImages || 0} raster image(s) and ${referenceSummary?.documents || 0} supporting document(s).` }),
    new Paragraph({ text: 'Preservation Focus', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: preservationFocus }),
    new Paragraph({ text: styleAnalysis?.notes || 'The design intent is to produce a credible rehabilitation vision rather than a disconnected redesign.' }),
    new Paragraph({ text: styleAnalysis?.reuseGuidance || 'Adaptive reuse interventions should remain consistent with the original building character and heritage significance.' }),
    new Paragraph({ text: 'Proposed Materials', heading: HeadingLevel.HEADING_2 }),
    ...materials.map(item => new Paragraph({ text: `- ${item}` })),
    new Paragraph({ text: 'Architectural Elements Used', heading: HeadingLevel.HEADING_2 }),
    ...(styleAnalysis?.elements?.length
      ? styleAnalysis.elements.map(item => new Paragraph({ text: `- ${item}` }))
      : [new Paragraph({ text: '- Heritage facade rhythm, openings, textures, and ornament are retained where possible.' })]),
    new Paragraph({ text: 'Building Requirements', heading: HeadingLevel.HEADING_2 }),
    new Paragraph({ text: extra || 'No special requirements were supplied beyond the rehabilitation brief.' }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'Ø§Ù„ØªØµÙˆØ±Ø§Øª Ø§Ù„Ù…ÙˆÙ„Ù‘Ø¯Ø©', heading: HeadingLevel.HEADING_2 }),
    ...views.map(v =>
      new Paragraph({ children: [new TextRun({ text: `âœ“ ${v.labelAr} (${v.labelEn})`, bold: true })] })
    ),
  ];

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buf);
}

// POST /api/service2/generate
// ══════════════════════════════════════════════════════════════════════════
router.post('/generate', (req, res, next) => {
  upload.array('images', 10)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const {
    style        = 'نجدي',
    buildingType = 'متحف',
    area         = '',
    floors       = '',
    specialReqs  = '',
    buildingName = '',
    numViews     = '8',
    prompt       = '',
  } = req.body || {};

  const jobId  = uuidv4();
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const viewCount = Math.min(parseInt(numViews) || DEFAULT_VIEW_COUNT, VIEWS.length);
  const viewsToRun = VIEWS.slice(0, viewCount);

  try {
    const t0 = Date.now();
    const results = [];
    const floorCount = getFloorCount(floors);

    console.log('\n' + '═'.repeat(60));
    console.log(`🏛️  SERVICE 02 JOB  |  id: ${jobId}`);
    console.log(`🎨  Style: ${style}  |  Type: ${buildingType}  |  Views: ${viewCount}`);
    console.log('═'.repeat(60));

    // ── STEP 2: GPT-4o/Replicate style analysis ────────────────────────────
    const referenceSummary = summarizeReferenceInputs(req.files || []);
    const validationError = validateReferenceFiles(req.files || []);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const refImagePaths = referenceSummary.rasterImagePaths;
    let styleAnalysis = null;
    console.log('\n[STEP 2] 🔍 GPT-4o/Replicate style analysis...');
    try {
      styleAnalysis = await analyzeStyleWithGPT4o(refImagePaths, style, buildingType);
      console.log(`         ✓ detected: ${styleAnalysis.detectedStyle} (${styleAnalysis.confidence})`);
    } catch(e) {
      console.warn('         ⚠ GPT-4o analysis skipped:', e.message);
    }

    for (const [i, view] of viewsToRun.entries()) {
      const vT0 = Date.now();
      console.log(`\n┌─ [${i+1}/${viewCount}] ▶ SDXL | ${view.labelEn} ─────────────────`);

      // ── STEP 3: GPT-4o/Replicate custom prompt engineering ───────────────
      let finalPrompt = null;
      try {
        finalPrompt = await engineerRehabilitationPromptWithGPT4o(
          style, buildingType, area, floors, specialReqs,
          buildingName, view.labelEn, styleAnalysis
        );
      } catch(e) {
        console.warn(`│  ⚠ GPT-4o prompt skipped: ${e.message}`);
      }
      // Fallback to built-in template if GPT-4o call fails
      const fluxPrompt = (finalPrompt ||
        buildRehabilitationPrompt(view, style, buildingType, area, floors, specialReqs, buildingName))
        + (prompt ? `, ${prompt}` : '');


      const aspectRatio = view.width > view.height ? '16:9' : '3:4';
      console.log(`│  Prompt: "${fluxPrompt.substring(0, 100)}..."`);
      console.log(`│  AR    : ${aspectRatio}  |  output: PNG`);
      console.log('│  Calling Replicate...');

      let imgUrl;
      try {
        const output = await replicate.run(
          'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
          {
            input: {
              // ── Prompt ────────────────────────────────
              prompt:          fluxPrompt,
              negative_prompt: NEGATIVE_PROMPT,
              // ── Aspect ratio (--ar 16:9 or --ar 3:4) ──
              width:           view.width,    // 1344 (16:9) or 1024 (3:4)
              height:          view.height,   //  768 (16:9) or 1365 (3:4)
              // ── Quality (--q 2 = highest) ──────────────
              num_inference_steps: 100,
              guidance_scale:      7.5,
              // ── Style raw (no artistic refiner) ────────
              refine:              'no_refiner',
              scheduler:           'K_EULER',
              // ── Output ─────────────────────────────────
              num_outputs:         1,
              apply_watermark:     false,
              disable_safety_checker: true,
            },
          }
        );
        imgUrl = String(Array.isArray(output) ? output[0] : output);
        if (!imgUrl.startsWith('http')) throw new Error(`Unexpected output: ${imgUrl.substring(0, 60)}`);
        console.log(`│  ✓ Done in ${((Date.now()-vT0)/1000).toFixed(1)}s`);
        console.log(`│  URL: ${imgUrl.substring(0, 70)}...`);
      } catch (e) {
        console.error(`│  ✗ SDXL failed: ${e.message}`);
        throw new Error(`SDXL generation failed for ${view.labelEn}: ${e.message}`);
      }




      // Download
      const baseName = `${String(i+1).padStart(2,'0')}_${view.id}`;
      const pngPath  = path.join(jobDir, `${baseName}.png`);
      const jpgPath  = path.join(jobDir, `${baseName}.jpg`);
      const tiffPath = path.join(jobDir, `${baseName}.tiff`);

      console.log(`│  Downloading...`);
      await downloadFile(imgUrl, pngPath);
      console.log(`│  ✓ PNG: ${(fs.statSync(pngPath).size/1024).toFixed(0)} KB`);
      await sharp(pngPath).jpeg({ quality: 95 }).toFile(jpgPath);
      await sharp(pngPath).tiff({ compression: 'lzw' }).toFile(tiffPath);
      console.log(`│  ✓ JPG + TIFF saved`);
      console.log(`└─ View ${i+1} complete ─────────────────────────────────────────`);

      results.push({ ...view, pngPath, jpgPath, tiffPath, prompt: fluxPrompt });
    }

    // ── PDF ──────────────────────────────────────────────────────────────
    console.log('\n[Post] Building PDF report...');
    const title = buildingName
      ? `التصور المعماري — ${buildingName}`
      : `التصور المعماري — ${style} / ${buildingType}`;
    const pdfPath  = path.join(jobDir, 'visualization_report.pdf');
    await buildPdf(results, pdfPath, title);
    console.log(`       ✓ PDF: ${(fs.statSync(pdfPath).size/1024).toFixed(0)} KB`);

    // ── Word ─────────────────────────────────────────────────────────────
    console.log('[Post] Building Word description...');
    const docxPath = path.join(jobDir, 'description.docx');
    await buildRehabilitationWord(results, style, buildingType, area, floors, specialReqs, buildingName, styleAnalysis, referenceSummary, docxPath);
    console.log(`       ✓ Word: ${(fs.statSync(docxPath).size/1024).toFixed(0)} KB`);

    // ── DXF Floor Plan (AutoCAD-compatible) ──────────────────────────────
    console.log('[Post] Building DXF floor plan...');
    const dxfPath  = path.join(jobDir, 'floor_plan.dxf');
    buildDxf(area, floors, buildingType, buildingName, dxfPath);
    console.log(`       ✓ DXF: ${(fs.statSync(dxfPath).size/1024).toFixed(0)} KB`);

    // ── SVG Floor Plan (visual) ───────────────────────────────────────────
    console.log('[Post] Building SVG floor plan...');
    const svgPath  = path.join(jobDir, 'floor_plan.svg');
    const planArtifacts = [];
    let sectionDxfPath = '';
    let sectionSvgPath = '';
    let sectionPdfPath = '';
    buildSvgFloorPlan(area, floors, buildingType, buildingName, svgPath);
    for (let floorIndex = 0; floorIndex < floorCount; floorIndex++) {
      const level = String(floorIndex + 1).padStart(2, '0');
      const levelDxfPath = path.join(jobDir, `floor_plan_level_${level}.dxf`);
      const levelSvgPath = path.join(jobDir, `floor_plan_level_${level}.svg`);
      const levelPdfPath = path.join(jobDir, `floor_plan_level_${level}.pdf`);
      buildDxf(area, floorCount, buildingType, `${buildingName || 'Building'} L${level}`, levelDxfPath);
      buildSvgFloorPlan(area, floorCount, buildingType, `${buildingName || 'Building'} L${level}`, levelSvgPath);
      await buildFloorPlanPdf(area, floorCount, buildingType, buildingName, floorIndex, levelPdfPath);
      planArtifacts.push({ floorIndex, dxfPath: levelDxfPath, svgPath: levelSvgPath, pdfPath: levelPdfPath });
    }
    sectionDxfPath = path.join(jobDir, 'section_a_a.dxf');
    sectionSvgPath = path.join(jobDir, 'section_a_a.svg');
    sectionPdfPath = path.join(jobDir, 'section_a_a.pdf');
    buildSectionDxf(area, floorCount, buildingName, sectionDxfPath);
    buildSectionSvg(area, floorCount, buildingName, sectionSvgPath);
    await buildSectionPdf(area, floorCount, buildingName, sectionPdfPath);
    console.log(`       ✓ SVG: ${(fs.statSync(svgPath).size/1024).toFixed(0)} KB`);

    // ── Excel Report ──────────────────────────────────────────────────────
    console.log('[Post] Building Excel report...');
    const xlsxPath = path.join(jobDir, 'report.xlsx');
    await buildExcel(results, style, buildingType, area, floors, buildingName, xlsxPath);
    const pptxPath = path.join(jobDir, 'presentation.pptx');
    await buildPptx(results, buildingName, style, buildingType, pptxPath);
    console.log(`       ✓ Excel: ${(fs.statSync(xlsxPath).size/1024).toFixed(0)} KB`);

    // ── Metadata JSON ─────────────────────────────────────────────────────
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId, service: 2,
      serviceName: SERVICE_02_NAME,
      serviceDefinition: SERVICE_02_DEFINITION,
      model: 'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
      style, buildingType, area, floors: floorCount, buildingName,
      viewsGenerated: viewCount,
      referenceInputs: referenceSummary,
      floorPlansGenerated: planArtifacts.length,
      sectionsGenerated: 1,
      styleAnalysis,
      gpt4oEnabled: true,
      processedAt: new Date().toISOString(),
      totalTimeSec: ((Date.now()-t0)/1000).toFixed(1),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // ── Build response ────────────────────────────────────────────────────
    const relUrl = p => `/outputs/${jobId}/${path.basename(p)}`;
    const outputFiles = [];
    for (const r of results) {
      outputFiles.push(
        { label: `${r.labelAr} — PNG`, url: relUrl(r.pngPath),  ext: 'png'  },
        { label: `${r.labelAr} — JPG`, url: relUrl(r.jpgPath),  ext: 'jpg'  },
        { label: `${r.labelAr} — TIFF`, url: relUrl(r.tiffPath), ext: 'tiff' },
      );
    }
    for (const plan of planArtifacts) {
      const level = String(plan.floorIndex + 1).padStart(2, '0');
      outputFiles.push(
        { label: `Floor Plan L${level} (DXF)`, url: relUrl(plan.dxfPath), ext: 'dxf', icon: 'PLAN' },
        { label: `Floor Plan L${level} (PDF)`, url: relUrl(plan.pdfPath), ext: 'pdf', icon: 'PDF' },
        { label: `Floor Plan L${level} (SVG)`, url: relUrl(plan.svgPath), ext: 'svg', icon: 'SVG' },
      );
    }
    outputFiles.push(
      { label: 'Visualization Report (PDF)',     url: relUrl(pdfPath),  ext: 'pdf',  icon: '📄' },
      { label: 'Project Description (Word)',      url: relUrl(docxPath), ext: 'docx', icon: '📝' },
      { label: 'Room Schedule (Excel)',           url: relUrl(xlsxPath), ext: 'xlsx', icon: '📊' },
      { label: 'Metadata (JSON)',                 url: relUrl(metaPath), ext: 'json', icon: '🗂️'  },
    );

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅  JOB DONE  |  ${results.length} views  |  ${((Date.now()-t0)/1000).toFixed(1)}s total`);
    console.log(`${'═'.repeat(60)}\n`);

    outputFiles.push(
      { label: 'Section A-A (DXF)',               url: relUrl(sectionDxfPath), ext: 'dxf', icon: 'SEC' },
      { label: 'Section A-A (PDF)',               url: relUrl(sectionPdfPath), ext: 'pdf', icon: 'PDF' },
      { label: 'Section A-A (SVG)',               url: relUrl(sectionSvgPath), ext: 'svg', icon: 'SVG' },
      { label: 'Presentation (PPTX)',             url: relUrl(pptxPath), ext: 'pptx', icon: 'PPT' },
    );

    return res.json({
      success: true,
      jobId,
      serviceName: SERVICE_02_NAME,
      serviceDefinition: SERVICE_02_DEFINITION,
      outputFiles,
      images: results.map(r => ({
        id:        r.id,
        labelAr:   r.labelAr,
        labelEn:   r.labelEn,
        outputUrl: relUrl(r.pngPath),
        aspect:    r.width > r.height ? '16:9' : '3:4',
      })),
    });

  } catch (err) {
    console.error('[S2] Fatal:', err.message);
    return res.status(500).json({ error: err.message || 'خطأ في توليد التصورات' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// POST /api/service2/image-to-prompt
// Upload one image → GPT-4o analyzes it → returns a Stable Diffusion prompt
// ══════════════════════════════════════════════════════════════════════════
const uploadSingle = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/image-to-prompt', (req, res, next) => {
  uploadSingle.single('image')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const ext  = path.extname(req.file.path).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    const b64  = fs.readFileSync(req.file.path).toString('base64');
    const dataUri = `data:${mime};base64,${b64}`;

    console.log(`\n[Image→Prompt] GPT-4o analyzing: ${req.file.originalname}`);

    const output = await replicate.run('openai/gpt-4o', {
      input: {
        system_prompt: `You are an expert architectural rehabilitation visualizer and Stable Diffusion XL prompt engineer.
Your job is to look at a reference image of a heritage or traditional building and write a high-quality prompt for a credible rehabilitation or adaptive reuse visualization that preserves the original identity.
Return ONLY the prompt, with no explanations, no preamble, and no quotes.`,
        prompt: `Analyze this architectural image and write a detailed Stable Diffusion XL prompt for a rehabilitation visualization.

Include:
- Existing architectural character and likely style
- The building type and a plausible adaptive reuse direction
- Materials, textures, facade rhythm, openings, roofline, and decorative details that should be preserved
- View angle (front facade / aerial / interior / night / etc.)
- Lighting conditions
- Atmosphere and mood
- A clear emphasis that this is a rehabilitation vision, not a totally new design

End the prompt with: architectural rehabilitation visualization, photorealistic, presentation render, highly detailed

Return ONLY the prompt text.`,
        image_input: [dataUri],
        max_completion_tokens: 300,
        temperature: 0.5,
      },
    });

    const generatedPrompt = (Array.isArray(output) ? output.join('') : String(output)).trim();
    console.log(`[Image→Prompt] ✓ Prompt generated (${generatedPrompt.length} chars)`);

    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});

    return res.json({ success: true, prompt: generatedPrompt });

  } catch (err) {
    console.error('[Image→Prompt] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
