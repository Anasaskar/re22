const express   = require('express');
const multer    = require('multer');
const sharp     = require('sharp');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');
const Replicate = require('replicate');
const PDFDocument = require('pdfkit');

let Document, Packer, Paragraph, TextRun, HeadingLevel;
try {
  ({ Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx'));
} catch(e) { console.warn('docx not loaded:', e.message); }

const Job = (() => { try { return require('../models/Job'); } catch { return null; } })();
const router = express.Router();

// ── Dirs ──────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Multer ────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename:    (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg','.jpeg','.png','.tiff','.tif','.raw'].includes(ext)) return cb(null, true);
    cb(new Error(`صيغة الملف غير مدعومة: ${ext}`));
  },
});

// ── Replicate ─────────────────────────────────────────────────────────────
const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// ── Helpers ───────────────────────────────────────────────────────────────
async function toPngBuffer(filePath) {
  // RAW and TIFF may need different handling; fall back to sharp
  try {
    return await sharp(filePath).png().toBuffer();
  } catch (e) {
    // already PNG/JPG readable — just read and convert
    return await sharp(filePath, { failOn: 'none' }).png().toBuffer();
  }
}

function toDataURL(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const getter = url.startsWith('https') ? https : http;
    getter.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', err => { fs.unlink(destPath, ()=>{}); reject(err); });
  });
}

async function buildPdfReport(items, outPath) {
  return new Promise((resolve, reject) => {
    const doc  = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(16).font('Helvetica-Bold')
       .text('Visual Intelligence Restoration Report', { align: 'center' });
    doc.fontSize(10).font('Helvetica')
       .text(`Generated: ${new Date().toISOString()} | Model: nightmareai/real-esrgan | Scale: 4x`,
             { align: 'center' });
    doc.moveDown(1);

    for (const [i, item] of items.entries()) {
      if (i > 0) doc.addPage();
      doc.fontSize(13).font('Helvetica-Bold')
         .text(`Image ${i+1}: ${item.originalName}`);
      doc.moveDown(0.4);

      const W = doc.page.width - 80;
      const colW = W / 2 - 5;
      const imgH = 200;
      const y = doc.y;

      try { doc.image(item.inputPath,  40,         y, { width: colW, height: imgH, fit: [colW, imgH] }); } catch {}
      try { doc.image(item.outputPng,  45 + colW,  y, { width: colW, height: imgH, fit: [colW, imgH] }); } catch {}

      doc.y = y + imgH + 10;
      doc.fontSize(9).fillColor('#888')
         .text('Before (Original)', 40, doc.y, { width: colW, align: 'center' });
      doc.text('After  (4× Real-ESRGAN)', 45 + colW, doc.y - 12, { width: colW, align: 'center' });
      doc.fillColor('black').moveDown(0.8);
      doc.fontSize(9)
         .text(`File size: ${(item.inputSizeBytes/1024).toFixed(0)} KB original`)
         .text(`Processing: AI super-resolution upscaling using nightmareai/real-esrgan`);
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildWordDoc(items, outPath) {
  if (!Document) { fs.writeFileSync(outPath, 'docx unavailable'); return; }
  const children = [
    new Paragraph({ text: 'Visual Intelligence Restoration — Enhancement Descriptions', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: `Date: ${new Date().toLocaleString()}` }),
    new Paragraph({ text: '' }),
  ];
  for (const [i, item] of items.entries()) {
    children.push(
      new Paragraph({ text: `Image ${i+1}: ${item.originalName}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [new TextRun({text:'Model: ',bold:true}), new TextRun('nightmareai/real-esrgan')] }),
      new Paragraph({ children: [new TextRun({text:'Scale: ',bold:true}), new TextRun('4×')] }),
      new Paragraph({ children: [new TextRun({text:'Processing: ',bold:true}), new TextRun('AI super-resolution applied to heritage building imagery. Architectural details, textures, and structural elements restored.')] }),
      new Paragraph({ text: '' }),
    );
  }
  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
}

// ── Route ─────────────────────────────────────────────────────────────────
router.post('/restore', (req, res, next) => {
  upload.array('images', 100)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: 'لم يتم رفع أي صور.' });

  const jobId  = uuidv4();
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Persist job if Mongo is available
  let job = null;
  if (Job) {
    try {
      job = await Job.create({
        jobId, service: 1, status: 'processing',
        inputFiles: req.files.map(f => ({ originalName: f.originalname, storedPath: f.path, sizeBytes: f.size })),
      });
    } catch { /* Mongo offline, continue */ }
  }

  try {
    const results = [];

    for (const [idx, file] of req.files.entries()) {
      console.log(`[S1] Processing image ${idx+1}/${req.files.length}: ${file.originalname}`);

      // Convert to PNG buffer for Replicate
      console.log(`[S1] Converting to PNG...`);
      const pngBuf  = await toPngBuffer(file.path);
      const dataUrl = toDataURL(pngBuf);
      console.log(`[S1] PNG buffer size: ${(pngBuf.length/1024).toFixed(0)} KB`);

      // Call Replicate — parse notes to influence model params
      const notes = (req.body && req.body.notes) ? req.body.notes.toLowerCase() : '';
      const faceEnhance = notes.includes('وجه') || notes.includes('face') || notes.includes('بشري');
      const scaleValue  = notes.includes('2x') || notes.includes('×2') ? 2 : 4;
      // Choose model variant based on notes
      let modelName = 'RealESRGAN_x4plus';
      if (notes.includes('anime') || notes.includes('انمي') || notes.includes('رسوم')) modelName = 'RealESRGAN_x4plus_anime_6B';
      if (scaleValue === 2) modelName = 'RealESRGAN_x2plus';

      console.log(`[S1] Replicate params: scale=${scaleValue} face=${faceEnhance} model=${modelName} notes="${notes.substring(0,60)}"`);
      let outputUrl;
      try {
        const output = await replicate.run('nightmareai/real-esrgan', {
          input: { image: dataUrl, scale: scaleValue, face_enhance: faceEnhance, model: modelName }
        });
        // Replicate v1.x returns FileOutput objects — String() extracts the URL
        outputUrl = String(output);
        console.log(`[S1] Replicate output: ${outputUrl.substring(0,80)}`);
        if (!outputUrl.startsWith('http')) throw new Error(`Unexpected output format: ${outputUrl.substring(0,60)}`);
      } catch(repErr) {
        console.error(`[S1] Replicate error:`, repErr.message);
        throw new Error(`Replicate API error: ${repErr.message}`);
      }

      // Clean numeric filename — avoids Windows UTF-8 encoding issues with Arabic names
      const baseName   = `image_${String(idx+1).padStart(2,'0')}`;
      const pngPath    = path.join(jobDir, `${baseName}_restored.png`);
      console.log(`[S1] Downloading result to ${pngPath}...`);
      await downloadFile(outputUrl, pngPath);

      // Generate JPG and TIFF via Sharp
      const jpgPath  = path.join(jobDir, `${baseName}_restored.jpg`);
      const tiffPath = path.join(jobDir, `${baseName}_restored.tiff`);
      await sharp(pngPath).jpeg({ quality: 95 }).toFile(jpgPath);
      await sharp(pngPath).tiff({ compression: 'lzw' }).toFile(tiffPath);

      results.push({
        originalName:   file.originalname,
        inputPath:      file.path,
        inputSizeBytes: file.size,
        outputPng:      pngPath,
        outputJpg:      jpgPath,
        outputTiff:     tiffPath,
      });
      console.log(`[S1] Image ${idx+1} done.`);
    }

    // PDF report
    console.log('[S1] Building PDF report...');
    const pdfPath  = path.join(jobDir, 'before_after_report.pdf');
    await buildPdfReport(results, pdfPath);

    // JSON metadata
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId, service: 1, model: 'nightmareai/real-esrgan', scale: 4,
      processedAt: new Date().toISOString(),
      imageCount: results.length,
      images: results.map(r => ({
        originalName: r.originalName,
        inputSizeKB: Math.round(r.inputSizeBytes / 1024),
      })),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    // Word doc
    console.log('[S1] Building Word doc...');
    const docxPath = path.join(jobDir, 'description.docx');
    await buildWordDoc(results, docxPath);

    // Build output file list
    const relUrl = p => `/outputs/${jobId}/${path.basename(p)}`;
    const outputFiles = [];
    for (const [idx, r] of results.entries()) {
      outputFiles.push(
        { label: `صورة ${idx+1} — PNG (بدون ضغط)`,      url: relUrl(r.outputPng),  ext: 'png'  },
        { label: `صورة ${idx+1} — JPG (عالي الجودة)`,    url: relUrl(r.outputJpg),  ext: 'jpg'  },
        { label: `صورة ${idx+1} — TIFF (للطباعة)`,       url: relUrl(r.outputTiff), ext: 'tiff' },
      );
    }

    outputFiles.push(
      { label: 'تقرير Before/After (PDF)',   url: relUrl(pdfPath),  ext: 'pdf'  },
      { label: 'بيانات العملية (JSON)',      url: relUrl(metaPath), ext: 'json' },
      { label: 'وصف التحسينات (Word)',       url: relUrl(docxPath), ext: 'docx' },
    );

    // Update job in Mongo if available
    if (job && job.save) {
      try { job.status = 'done'; job.outputFiles = outputFiles; job.completedAt = new Date(); job.metadata = meta; await job.save(); }
      catch { /* ok */ }
    }

    console.log(`[S1] Job ${jobId} complete. ${results.length} images processed.`);
    return res.json({
      success: true,
      jobId,
      outputFiles,
      images: results.map(r => ({
        originalName: r.originalName,
        inputUrl:  `/uploads/${path.basename(r.inputPath)}`,
        outputUrl: relUrl(r.outputPng),
      })),
    });

  } catch (err) {
    console.error('[S1] Fatal error:', err);
    if (job && job.save) { try { job.status = 'failed'; job.error = err.message; await job.save(); } catch {} }
    return res.status(500).json({ error: err.message || 'خطأ في المعالجة' });
  }
});

// Job status
router.get('/job/:jobId', async (req, res) => {
  if (!Job) return res.status(503).json({ error: 'Database unavailable' });
  try {
    const job = await Job.findOne({ jobId: req.params.jobId });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2: GFPGAN Face & Detail Enhancement ──────────────────────────────
// POST /api/service1/enhance/:jobId
// Body JSON: { images: [ { esrganUrl, index } ] }
router.post('/enhance/:jobId', express.json(), async (req, res) => {
  const { jobId } = req.params;
  const jobDir = path.join(OUTPUTS_DIR, jobId);

  if (!fs.existsSync(jobDir))
    return res.status(404).json({ error: 'Job not found — invalid jobId' });

  // Accept list of esrgan output URLs from frontend
  const imagesToEnhance = req.body && req.body.images;
  if (!imagesToEnhance || !imagesToEnhance.length)
    return res.status(400).json({ error: 'No images provided' });

  try {
    const results = [];

    for (const [i, item] of imagesToEnhance.entries()) {
      const idx     = item.index !== undefined ? item.index : i;
      const esrUrl  = item.esrganUrl; // full URL like /outputs/jobId/image_01_restored.png

      console.log(`[S1-GFPGAN] Processing image ${idx+1}: ${esrUrl}`);

      // Resolve local path from relative URL
      const localPath = path.join(__dirname, '../../public', esrUrl);

      // Convert local file → data URL for GFPGAN
      let inputDataUrl;
      if (fs.existsSync(localPath)) {
        const buf = await toPngBuffer(localPath);
        inputDataUrl = toDataURL(buf);
        console.log(`[S1-GFPGAN] Local file loaded (${(buf.length/1024).toFixed(0)} KB)`);
      } else {
        // Fallback: pass the full URL if local file not found
        const host = `http://localhost:${process.env.PORT || 3000}`;
        inputDataUrl = `${host}${esrUrl}`;
        console.log(`[S1-GFPGAN] Using URL fallback: ${inputDataUrl}`);
      }

      // Call GFPGAN
      console.log(`[S1-GFPGAN] Calling tencentarc/gfpgan...`);
      let gfpganUrl;
      try {
        const output = await replicate.run(
          'tencentarc/gfpgan:0fbacf7afc6c144e5be9767cff80f25aff23e52b0708f17e20f9879b2f21516c',
          { input: { img: inputDataUrl, version: '1.4', scale: 2 } }
        );
        gfpganUrl = String(output);
        console.log(`[S1-GFPGAN] Output: ${gfpganUrl.substring(0, 80)}`);
        if (!gfpganUrl.startsWith('http')) throw new Error(`Unexpected GFPGAN output: ${gfpganUrl.substring(0,60)}`);
      } catch (e) {
        console.error(`[S1-GFPGAN] Error:`, e.message);
        throw new Error(`GFPGAN error: ${e.message}`);
      }

      // Download and save GFPGAN output
      const baseName  = `image_${String(idx+1).padStart(2,'0')}`;
      const gfpPng    = path.join(jobDir, `${baseName}_gfpgan.png`);
      const gfpJpg    = path.join(jobDir, `${baseName}_gfpgan.jpg`);
      const gfpTiff   = path.join(jobDir, `${baseName}_gfpgan.tiff`);

      await downloadFile(gfpganUrl, gfpPng);
      await sharp(gfpPng).jpeg({ quality: 95 }).toFile(gfpJpg);
      await sharp(gfpPng).tiff({ compression: 'lzw' }).toFile(gfpTiff);

      const relUrl = p => `/outputs/${jobId}/${path.basename(p)}`;
      results.push({
        index:      idx,
        esrganUrl:  esrUrl,           // before (ESRGAN output)
        gfpganUrl:  relUrl(gfpPng),   // after  (GFPGAN output)
        outputs: [
          { label: `صورة ${idx+1} — PNG (GFPGAN)`,        url: relUrl(gfpPng),  ext: 'png'  },
          { label: `صورة ${idx+1} — JPG (GFPGAN)`,        url: relUrl(gfpJpg),  ext: 'jpg'  },
          { label: `صورة ${idx+1} — TIFF (GFPGAN)`,       url: relUrl(gfpTiff), ext: 'tiff' },
        ],
      });
      console.log(`[S1-GFPGAN] Image ${idx+1} done.`);
    }

    return res.json({ success: true, jobId, results });

  } catch (err) {
    console.error('[S1-GFPGAN] Fatal error:', err);
    return res.status(500).json({ error: err.message || 'GFPGAN processing failed' });
  }
});

module.exports = router;

