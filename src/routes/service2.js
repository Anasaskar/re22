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


// ── Storage ───────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

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
  if (!imagePaths || imagePaths.length === 0) {
    return { detectedStyle: style, confidence: 'N/A', notes: 'No reference images provided.' };
  }

  console.log(`[GPT-4o/Replicate] Analyzing ${imagePaths.length} reference image(s) for style classification...`);

  // Convert local image files to base64 data URIs for Replicate
  const imageInputs = imagePaths.slice(0, 3).map(p => {
    const ext = path.extname(p).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
  });

  const output = await replicate.run('openai/gpt-4o', {
    input: {
      system_prompt: 'You are an expert in Saudi traditional architecture. Always respond with valid JSON only.',
      prompt: `Analyze these reference images of a building.
Identify:
1) Architectural style (Najdi / Hejazi / Asiri / Contemporary Heritage / Mixed)
2) Key visible elements (materials, patterns, roof type, windows, decorations)
3) Rehabilitation potential

User selected style: ${style}. Building function: ${buildingType}.

Return ONLY this JSON structure, no other text:
{ "detectedStyle": "...", "confidence": "High/Medium/Low", "elements": ["..."], "notes": "..." }`,
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

// ══════════════════════════════════════════════════════════════════════════
// Excel Report Generator (room schedule + area table)
// ══════════════════════════════════════════════════════════════════════════
async function buildExcel(results, style, funcKey, area, floors, buildingName, xlsxPath) {
  const wb  = new ExcelJS.Workbook();
  wb.creator = 'Heritage Rehabilitation Platform';
  wb.created = new Date();

  // ── Sheet 1: Project Summary ──────────────────────────────────────────
  const sum = wb.addWorksheet('Project Summary');
  sum.columns = [{ width: 28 }, { width: 40 }];
  const header = sum.addRow(['Heritage Architectural Visualization Report']);
  header.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  header.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1521' } };
  sum.mergeCells('A1:B1');
  header.alignment = { horizontal: 'center' };
  sum.addRow([]);
  const fields = [
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

const NEGATIVE_PROMPT =
  'blurry, low quality, distorted, cartoon, sketch, anime, ugly, deformed, ' +
  'modern style, western architecture, flat design, watermark, text overlay, ' +
  'overexposed, underexposed, noise, artifacts';

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

  const viewCount = Math.min(parseInt(numViews) || 8, 8);
  const viewsToRun = VIEWS.slice(0, viewCount);

  try {
    const t0 = Date.now();
    const results = [];

    console.log('\n' + '═'.repeat(60));
    console.log(`🏛️  SERVICE 02 JOB  |  id: ${jobId}`);
    console.log(`🎨  Style: ${style}  |  Type: ${buildingType}  |  Views: ${viewCount}`);
    console.log('═'.repeat(60));

    // ── STEP 2: GPT-4o/Replicate style analysis ────────────────────────────
    const refImagePaths = (req.files || []).map(f => f.path);
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
        finalPrompt = await engineerPromptWithGPT4o(
          style, buildingType, area, floors, specialReqs,
          buildingName, view.labelEn, styleAnalysis
        );
      } catch(e) {
        console.warn(`│  ⚠ GPT-4o prompt skipped: ${e.message}`);
      }
      // Fallback to built-in template if GPT-4o call fails
      const fluxPrompt = (finalPrompt ||
        buildPrompt(view, style, buildingType, area, floors, specialReqs, buildingName))
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
    await buildWord(results, style, buildingType, area, floors, specialReqs, buildingName, docxPath);
    console.log(`       ✓ Word: ${(fs.statSync(docxPath).size/1024).toFixed(0)} KB`);

    // ── DXF Floor Plan (AutoCAD-compatible) ──────────────────────────────
    console.log('[Post] Building DXF floor plan...');
    const dxfPath  = path.join(jobDir, 'floor_plan.dxf');
    buildDxf(area, floors, buildingType, buildingName, dxfPath);
    console.log(`       ✓ DXF: ${(fs.statSync(dxfPath).size/1024).toFixed(0)} KB`);

    // ── SVG Floor Plan (visual) ───────────────────────────────────────────
    console.log('[Post] Building SVG floor plan...');
    const svgPath  = path.join(jobDir, 'floor_plan.svg');
    buildSvgFloorPlan(area, floors, buildingType, buildingName, svgPath);
    console.log(`       ✓ SVG: ${(fs.statSync(svgPath).size/1024).toFixed(0)} KB`);

    // ── Excel Report ──────────────────────────────────────────────────────
    console.log('[Post] Building Excel report...');
    const xlsxPath = path.join(jobDir, 'report.xlsx');
    await buildExcel(results, style, buildingType, area, floors, buildingName, xlsxPath);
    console.log(`       ✓ Excel: ${(fs.statSync(xlsxPath).size/1024).toFixed(0)} KB`);

    // ── Metadata JSON ─────────────────────────────────────────────────────
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId, service: 2,
      model: 'stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc',
      style, buildingType, area, floors, buildingName,
      viewsGenerated: viewCount,
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
    outputFiles.push(
      { label: 'Visualization Report (PDF)',     url: relUrl(pdfPath),  ext: 'pdf',  icon: '📄' },
      { label: 'Project Description (Word)',      url: relUrl(docxPath), ext: 'docx', icon: '📝' },
      { label: 'Floor Plan (DXF — AutoCAD)',      url: relUrl(dxfPath),  ext: 'dxf',  icon: '📐' },
      { label: 'Floor Plan (SVG — Visual)',       url: relUrl(svgPath),  ext: 'svg',  icon: '🗺️'  },
      { label: 'Room Schedule (Excel)',           url: relUrl(xlsxPath), ext: 'xlsx', icon: '📊' },
      { label: 'Metadata (JSON)',                 url: relUrl(metaPath), ext: 'json', icon: '🗂️'  },
    );

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅  JOB DONE  |  ${results.length} views  |  ${((Date.now()-t0)/1000).toFixed(1)}s total`);
    console.log(`${'═'.repeat(60)}\n`);

    return res.json({
      success: true,
      jobId,
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
        system_prompt: `You are an expert Stable Diffusion XL prompt engineer.
Your job: look at an architectural image and write a high-quality text prompt
that, when given to Stable Diffusion, will recreate a similar image.
Return ONLY the prompt — no explanations, no preamble, no quotes.`,
        prompt: `Analyze this architectural image and write a detailed Stable Diffusion XL prompt to recreate it.

Include:
- Architectural style (Najdi / Hejazi / Asiri / Contemporary / Heritage / etc.)
- Building type and function
- Materials and textures visible
- View angle (front facade / aerial / interior / night / etc.)
- Lighting conditions
- Atmosphere and mood
- Any distinctive decorative elements

End the prompt with: natural lighting, Saudi Arabia, architectural photography, highly detailed, 8K

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
