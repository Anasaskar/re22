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
    const t0 = Date.now();

    console.log('\n' + '═'.repeat(60));
    console.log(`🚀  JOB STARTED  |  id: ${jobId}`);
    console.log(`📂  Images: ${req.files.length}  |  ${new Date().toLocaleTimeString()}`);
    console.log('═'.repeat(60));

    // Restoration prompt for Nano Banana
    const userPrompt = (req.body && req.body.prompt && req.body.prompt.trim())
      ? req.body.prompt.trim()
      : 'Restore this historic building realistically. Reconstruct missing architectural sections, repair cracks and collapsed walls, preserve the original heritage style, maintain the same camera angle and lighting, keep authentic materials and traditional decorative details, do not modernize the building.';

    for (const [idx, file] of req.files.entries()) {
      // Decode Arabic / non-ASCII filenames (multer stores bytes as Latin-1)
      const cleanName = (() => {
        try { return Buffer.from(file.originalname, 'latin1').toString('utf8'); }
        catch { return `image_${String(idx+1).padStart(2,'0')}`; }
      })();

      const imgT0 = Date.now();
      console.log(`\n┌─ Image ${idx+1}/${req.files.length} ─────────────────────────────────`);
      console.log(`│  File   : ${cleanName}`);
      console.log(`│  Size   : ${(file.size/1024).toFixed(0)} KB`);


      // ── Phase 1-A: Prepare input ────────────────────────────────────
      console.log('│');
      console.log('│  [A] Converting to PNG for Nano Banana...');
      const pngBuf  = await toPngBuffer(file.path);
      const dataUrl = toDataURL(pngBuf);
      console.log(`│      ✓ PNG ready — ${(pngBuf.length/1024).toFixed(0)} KB`);

      // ── Phase 1-B: Nano Banana ──────────────────────────────────────
      console.log('│');
      console.log('│  [B] ▶ google/nano-banana-2  (Phase 1: Restoration)');
      console.log(`│      Prompt : "${userPrompt.substring(0, 80)}"`);
      console.log('│      Calling Replicate API...');
      const nbT0 = Date.now();
      let nanoBananaUrl;
      try {
        const nbOutput = await replicate.run('google/nano-banana-2', {
          input: {
            prompt:        userPrompt,
            image_input:   [dataUrl],
            aspect_ratio:  'match_input_image',
            resolution:    '1K',
            output_format: 'jpg',
          },
        });
        nanoBananaUrl = String(Array.isArray(nbOutput) ? nbOutput[0] : nbOutput);
        if (!nanoBananaUrl.startsWith('http')) throw new Error(`Unexpected output: ${nanoBananaUrl.substring(0,60)}`);
        console.log(`│      ✓ Done in ${((Date.now()-nbT0)/1000).toFixed(1)}s`);
        console.log(`│      URL: ${nanoBananaUrl.substring(0,70)}...`);
      } catch(nbErr) {
        console.error(`│  ✗ Nano Banana failed: ${nbErr.message}`);
        throw new Error(`Nano Banana error: ${nbErr.message}`);
      }

      // ── Phase 1-C: Download Nano Banana output ──────────────────────
      const baseName = `image_${String(idx+1).padStart(2,'0')}`;
      const nbJpg    = path.join(jobDir, `${baseName}_nanobana.jpg`);
      console.log('│');
      console.log('│  [C] Downloading Nano Banana output...');
      await downloadFile(nanoBananaUrl, nbJpg);
      console.log(`│      ✓ Saved JPG — ${(fs.statSync(nbJpg).size/1024).toFixed(0)} KB`);

      // ── Phase 2-A: Convert NB output for ESRGAN ─────────────────────
      console.log('│');
      console.log('│  [D] Converting Nano Banana output for Real-ESRGAN...');
      const nbBuf       = await toPngBuffer(nbJpg);
      const nbDataUrl   = toDataURL(nbBuf);
      console.log(`│      ✓ Ready — ${(nbBuf.length/1024).toFixed(0)} KB`);

      // ── Phase 2-B: Real-ESRGAN ×4 ───────────────────────────────────
      console.log('│');
      console.log('│  [E] ▶ nightmareai/real-esrgan  (Phase 2: ×4 Upscale)');
      console.log('│      Scale    : ×4');
      console.log('│      Calling Replicate API...');
      const esrT0 = Date.now();
      let esrUrl;
      try {
        const esrOutput = await replicate.run('nightmareai/real-esrgan', {
          input: { image: nbDataUrl, scale: 4, face_enhance: false },
        });
        esrUrl = String(esrOutput);
        if (!esrUrl.startsWith('http')) throw new Error(`Unexpected output: ${esrUrl.substring(0,60)}`);
        console.log(`│      ✓ Done in ${((Date.now()-esrT0)/1000).toFixed(1)}s`);
        console.log(`│      URL: ${esrUrl.substring(0,70)}...`);
      } catch(repErr) {
        console.error(`│  ✗ Real-ESRGAN failed: ${repErr.message}`);
        throw new Error(`Real-ESRGAN error: ${repErr.message}`);
      }

      // ── Phase 2-C: Download & convert ESRGAN output ─────────────────
      const pngPath  = path.join(jobDir, `${baseName}_restored.png`);
      const jpgPath  = path.join(jobDir, `${baseName}_restored.jpg`);
      const tiffPath = path.join(jobDir, `${baseName}_restored.tiff`);
      console.log('│');
      console.log('│  [F] Downloading & converting final output...');
      await downloadFile(esrUrl, pngPath);
      console.log(`│      ✓ PNG saved — ${(fs.statSync(pngPath).size/1024).toFixed(0)} KB`);
      await sharp(pngPath).jpeg({ quality: 95 }).toFile(jpgPath);
      console.log(`│      ✓ JPG saved — ${(fs.statSync(jpgPath).size/1024).toFixed(0)} KB`);
      await sharp(pngPath).tiff({ compression: 'lzw' }).toFile(tiffPath);
      console.log(`│      ✓ TIFF saved — ${(fs.statSync(tiffPath).size/1024).toFixed(0)} KB`);

      results.push({
        originalName:      cleanName,
        inputPath:         file.path,
        inputSizeBytes:    file.size,
        nanoBananaPath:    nbJpg,
        outputPng:         pngPath,
        outputJpg:         jpgPath,
        outputTiff:        tiffPath,
      });
      console.log(`└─ Image ${idx+1} complete in ${((Date.now()-imgT0)/1000).toFixed(1)}s ────────────────────`);
    }


    // ── Step E: PDF Report ────────────────────────────────────────────────
    console.log('\n[E] Building PDF before/after report...');
    const pdfPath  = path.join(jobDir, 'before_after_report.pdf');
    await buildPdfReport(results, pdfPath);
    console.log(`    ✓ PDF saved — ${(fs.statSync(pdfPath).size/1024).toFixed(0)} KB`);

    // ── Step F: Metadata JSON ─────────────────────────────────────────────
    console.log('[F] Writing metadata.json...');
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId, service: 1,
      pipeline: 'google/nano-banana-2 → nightmareai/real-esrgan ×4',
      processedAt: new Date().toISOString(),
      imageCount: results.length,
      images: results.map(r => ({
        originalName: r.originalName,
        inputSizeKB: Math.round(r.inputSizeBytes / 1024),
      })),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`    ✓ metadata.json written`);

    // ── Step G: Word doc ──────────────────────────────────────────────────
    console.log('[G] Building Word description doc...');
    const docxPath = path.join(jobDir, 'description.docx');
    await buildWordDoc(results, docxPath);
    console.log(`    ✓ description.docx written`);

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

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅  JOB DONE  |  ${results.length} image(s)  |  ${((Date.now()-t0)/1000).toFixed(1)}s total`);
    console.log(`📁  Output: outputs/${jobId}`);
    console.log(`${'═'.repeat(60)}\n`);
    return res.json({
      success: true,
      jobId,
      outputFiles,
      images: results.map(r => ({
        originalName:  r.originalName,
        inputUrl:      `/uploads/${path.basename(r.inputPath)}`,
        nanoBananaUrl: relUrl(r.nanoBananaPath),
        outputUrl:     relUrl(r.outputPng),
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

// ── Step 2: Flux Canny Pro — Edge-guided regeneration ────────────────────
// POST /api/service1/enhance/:jobId
// Body JSON: { images: [ { esrganUrl, index } ], prompt?: string }
router.post('/enhance/:jobId', express.json(), async (req, res) => {
  const { jobId } = req.params;
  const jobDir = path.join(OUTPUTS_DIR, jobId);

  if (!fs.existsSync(jobDir))
    return res.status(404).json({ error: 'Job not found — invalid jobId' });

  const imagesToEnhance = req.body && req.body.images;
  if (!imagesToEnhance || !imagesToEnhance.length)
    return res.status(400).json({ error: 'No images provided' });

  // Prompt: from frontend, or default heritage prompt
  const userPrompt = (req.body.prompt || '').trim() ||
    'Heritage building restoration, high-resolution architectural photography, photorealistic, detailed stone textures, preserved historical details';

  try {
    const results = [];
    const t0 = Date.now();

    console.log('\n' + '═'.repeat(60));
    console.log(`🎨  FLUX CANNY PRO — STEP 2  |  job: ${jobId}`);
    console.log(`📂  Images: ${imagesToEnhance.length}  |  ${new Date().toLocaleTimeString()}`);
    console.log(`💬  Prompt: "${userPrompt.substring(0, 70)}"`);
    console.log('═'.repeat(60));

    for (const [i, item] of imagesToEnhance.entries()) {
      const idx    = item.index !== undefined ? item.index : i;
      const esrUrl = item.esrganUrl;
      const imgT0  = Date.now();

      console.log(`\n┌─ Image ${idx+1} ─────────────────────────────────────────────`);
      console.log(`│  ESRGAN input : ${esrUrl}`);

      // ── Step A: Load ESRGAN output ───────────────────────────────────
      const localPath = path.join(__dirname, '../../public', esrUrl);
      let controlImage;
      console.log('│');
      console.log('│  [A] Loading Real-ESRGAN output as control image...');
      if (fs.existsSync(localPath)) {
        const buf = await toPngBuffer(localPath);
        controlImage = toDataURL(buf);
        console.log(`│      ✓ Loaded from disk — ${(buf.length/1024).toFixed(0)} KB (base64 ready)`);
      } else {
        // Fallback: public URL — Replicate can't reach localhost but try
        controlImage = `http://localhost:${process.env.PORT || 3000}${esrUrl}`;
        console.log(`│      ⚠ Not on disk, using URL: ${controlImage}`);
      }

      // ── Step B: Flux Canny Pro ────────────────────────────────────────
      console.log('│');
      console.log('│  [B] ▶ black-forest-labs/flux-canny-pro');
      console.log(`│      Prompt   : "${userPrompt.substring(0, 70)}"`);
      console.log('│      Steps    : 28');
      console.log('│      Guidance : 7.5');
      console.log('│      Calling Replicate API...');
      const fluxT0 = Date.now();
      let fluxUrl;
      try {
        const output = await replicate.run('black-forest-labs/flux-canny-pro', {
          input: {
            control_image:  controlImage,
            prompt:         userPrompt,
            steps:          28,
            guidance:       7.5,
            output_format:  'png',
            output_quality: 95,
          },
        });
        fluxUrl = String(output);
        if (!fluxUrl.startsWith('http')) throw new Error(`Unexpected output: ${fluxUrl.substring(0, 60)}`);
        console.log(`│      ✓ Done in ${((Date.now()-fluxT0)/1000).toFixed(1)}s`);
        console.log(`│      URL: ${fluxUrl.substring(0, 70)}...`);
      } catch (e) {
        console.error(`│  ✗ Flux Canny Pro failed: ${e.message}`);
        throw new Error(`Flux Canny Pro error: ${e.message}`);
      }


      // ── Step C: Download ─────────────────────────────────────────────
      console.log('│');
      console.log('│  [C] Downloading Flux Canny Pro output...');
      const baseName = `image_${String(idx+1).padStart(2,'0')}`;
      const fluxPng  = path.join(jobDir, `${baseName}_flux.png`);
      const fluxJpg  = path.join(jobDir, `${baseName}_flux.jpg`);
      const fluxTiff = path.join(jobDir, `${baseName}_flux.tiff`);
      await downloadFile(fluxUrl, fluxPng);
      console.log(`│      ✓ PNG saved — ${(fs.statSync(fluxPng).size/1024).toFixed(0)} KB`);

      // ── Step D: Convert ──────────────────────────────────────────────
      console.log('│');
      console.log('│  [D] Generating output formats...');
      await sharp(fluxPng).jpeg({ quality: 95 }).toFile(fluxJpg);
      console.log(`│      ✓ JPG saved — ${(fs.statSync(fluxJpg).size/1024).toFixed(0)} KB`);
      await sharp(fluxPng).tiff({ compression: 'lzw' }).toFile(fluxTiff);
      console.log(`│      ✓ TIFF saved — ${(fs.statSync(fluxTiff).size/1024).toFixed(0)} KB`);

      const relUrl = p => `/outputs/${jobId}/${path.basename(p)}`;
      results.push({
        index:    idx,
        esrganUrl: esrUrl,
        fluxUrl:  relUrl(fluxPng),
        outputs: [
          { label: `صورة ${idx+1} — PNG (Flux Canny Pro)`,  url: relUrl(fluxPng),  ext: 'png'  },
          { label: `صورة ${idx+1} — JPG (Flux Canny Pro)`,  url: relUrl(fluxJpg),  ext: 'jpg'  },
          { label: `صورة ${idx+1} — TIFF (Flux Canny Pro)`, url: relUrl(fluxTiff), ext: 'tiff' },
        ],
      });
      console.log(`└─ Image ${idx+1} done in ${((Date.now()-imgT0)/1000).toFixed(1)}s ────────────────────────────`);
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅  FLUX CANNY PRO DONE  |  ${results.length} image(s)  |  ${((Date.now()-t0)/1000).toFixed(1)}s total`);
    console.log(`${'═'.repeat(60)}\n`);

    return res.json({ success: true, jobId, results });

  } catch (err) {
    console.error('\n✗ [Flux Canny Pro] Fatal error:', err.message);
    return res.status(500).json({ error: err.message || 'Flux Canny Pro processing failed' });
  }
});

module.exports = router;
