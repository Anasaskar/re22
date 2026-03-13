const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const Replicate = require('replicate');
const PDFDocument = require('pdfkit');

let Document, Packer, Paragraph, TextRun, HeadingLevel;
try {
  ({ Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx'));
} catch (e) {
  console.warn('docx not loaded:', e.message);
}

const Job = (() => {
  try {
    return require('../models/Job');
  } catch {
    return null;
  }
})();

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');
const OUTPUTS_DIR = path.join(__dirname, '../../public/outputs');
[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));
const PDF_FONT_REGULAR = 'C:\\Windows\\Fonts\\arial.ttf';
const PDF_FONT_BOLD = 'C:\\Windows\\Fonts\\arialbd.ttf';

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.raw'].includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

async function toPngBuffer(filePath) {
  try {
    return await sharp(filePath).png().toBuffer();
  } catch {
    return await sharp(filePath, { failOn: 'none' }).png().toBuffer();
  }
}

function toDataURL(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function relOutputUrl(jobId, filePath) {
  return `/outputs/${jobId}/${path.basename(filePath)}`;
}

function publicPathFromUrl(urlPath) {
  return path.join(__dirname, '../../public', String(urlPath || '').replace(/^\/+/, ''));
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function mojibakeScore(value) {
  const text = String(value || '');
  const badChars = (text.match(/[ÃÂÐÑØÙ�]/g) || []).length;
  const replacementChars = (text.match(/\uFFFD/g) || []).length * 4;
  const controlChars = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length * 2;
  return badChars + replacementChars + controlChars;
}

function arabicScore(value) {
  return (String(value || '').match(/[\u0600-\u06FF]/g) || []).length;
}

function decodeOriginalName(file, index) {
  const fallback = `image_${String(index + 1).padStart(2, '0')}`;
  const original = String(file.originalname || '').trim() || fallback;

  try {
    const decoded = Buffer.from(original, 'latin1').toString('utf8').trim() || original;
    const originalScore = mojibakeScore(original);
    const decodedScore = mojibakeScore(decoded);

    if (decodedScore < originalScore) return decoded;
    if (decodedScore === originalScore && arabicScore(decoded) > arabicScore(original)) return decoded;
    return original;
  } catch {
    return original;
  }
}

function toEnglishDisplayName(fileName, index) {
  const original = String(fileName || '').trim();
  const ext = (path.extname(original).toLowerCase() || '.png').replace(/[^a-z0-9.]/g, '') || '.png';
  return `image_${String(index + 1).padStart(2, '0')}${ext}`;
}

function setPdfFont(doc, bold = false) {
  const fontPath = bold ? PDF_FONT_BOLD : PDF_FONT_REGULAR;
  if (fs.existsSync(fontPath)) {
    return doc.font(fontPath);
  }
  return doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
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
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
      file.on('error', reject);
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function buildPdfReport(items, outPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    doc.fontSize(16);
    setPdfFont(doc, true)
      .text('Visual Intelligence Restoration Report', { align: 'center' });
    doc.fontSize(10);
    setPdfFont(doc)
      .text(`Generated: ${new Date().toISOString()} | Model: nightmareai/real-esrgan | Scale: 4x`, { align: 'center' });
    doc.moveDown(1);

    for (const [i, item] of items.entries()) {
      if (i > 0) doc.addPage();

      doc.fontSize(13);
      setPdfFont(doc, true)
        .text(`Image ${i + 1}: ${item.originalName}`);
      doc.moveDown(0.4);

      const width = doc.page.width - 80;
      const colWidth = width / 2 - 5;
      const imageHeight = 200;
      const y = doc.y;

      try { doc.image(item.inputPath, 40, y, { width: colWidth, height: imageHeight, fit: [colWidth, imageHeight] }); } catch {}
      try { doc.image(item.outputPng, 45 + colWidth, y, { width: colWidth, height: imageHeight, fit: [colWidth, imageHeight] }); } catch {}

      doc.y = y + imageHeight + 10;
      doc.fontSize(9).fillColor('#888');
      setPdfFont(doc)
        .text('Before (Original)', 40, doc.y, { width: colWidth, align: 'center' });
      doc.text('After (Real-ESRGAN x4)', 45 + colWidth, doc.y - 12, { width: colWidth, align: 'center' });
      doc.fillColor('black').moveDown(0.8);
      doc.fontSize(9);
      setPdfFont(doc)
        .text(`Original file size: ${(item.inputSizeBytes / 1024).toFixed(0)} KB`)
        .text('Processing: AI super-resolution upscaling using nightmareai/real-esrgan');
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function buildWordDoc(items, outPath) {
  if (!Document) {
    fs.writeFileSync(outPath, 'docx unavailable');
    return;
  }

  const children = [
    new Paragraph({
      text: 'Visual Intelligence Restoration - Enhancement Descriptions',
      heading: HeadingLevel.HEADING_1,
    }),
    new Paragraph({ text: `Date: ${new Date().toLocaleString()}` }),
    new Paragraph({ text: '' }),
  ];

  for (const [i, item] of items.entries()) {
    children.push(
      new Paragraph({ text: `Image ${i + 1}: ${item.originalName}`, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [new TextRun({ text: 'Model: ', bold: true }), new TextRun('nightmareai/real-esrgan')] }),
      new Paragraph({ children: [new TextRun({ text: 'Scale: ', bold: true }), new TextRun('4x')] }),
      new Paragraph({ children: [new TextRun({ text: 'Processing: ', bold: true }), new TextRun('AI super-resolution applied after Nano Banana restoration.')] }),
      new Paragraph({ text: '' }),
    );
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
}

router.post('/restore', (req, res, next) => {
  upload.array('images', 100)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded.' });
  }

  const jobId = uuidv4();
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  let job = null;
  if (Job) {
    try {
      job = await Job.create({
        jobId,
        service: 1,
        status: 'processing',
        inputFiles: req.files.map((file, index) => ({
          originalName: toEnglishDisplayName(file.originalname, index),
          storedPath: file.path,
          sizeBytes: file.size,
        })),
      });
    } catch {}
  }

  try {
    const results = [];
    const t0 = Date.now();

    console.log('\n' + '='.repeat(60));
    console.log(`SERVICE 1 STEP 1 STARTED | job: ${jobId}`);
    console.log(`Images: ${req.files.length}`);
    console.log('='.repeat(60));

    const userPrompt = (req.body && req.body.prompt && req.body.prompt.trim())
      ? req.body.prompt.trim()
      : 'Restore this historic building realistically. Reconstruct missing architectural sections, repair cracks and collapsed walls, preserve the original heritage style, maintain the same camera angle and lighting, keep authentic materials and traditional decorative details, do not modernize the building.';

    for (const [idx, file] of req.files.entries()) {
      const cleanName = toEnglishDisplayName(file.originalname, idx);
      const imgT0 = Date.now();
      const baseName = `image_${String(idx + 1).padStart(2, '0')}`;
      const restoredPng = path.join(jobDir, `${baseName}_restored.png`);
      const restoredJpg = path.join(jobDir, `${baseName}_restored.jpg`);
      const restoredTiff = path.join(jobDir, `${baseName}_restored.tiff`);

      console.log(`Processing step 1 image ${idx + 1}/${req.files.length}: ${cleanName}`);

      const pngBuf = await toPngBuffer(file.path);
      const dataUrl = toDataURL(pngBuf);

      let nanoBananaUrl;
      try {
        const nbOutput = await replicate.run('google/nano-banana-2', {
          input: {
            prompt: userPrompt,
            image_input: [dataUrl],
            aspect_ratio: 'match_input_image',
            resolution: '1K',
            output_format: 'jpg',
          },
        });
        nanoBananaUrl = String(Array.isArray(nbOutput) ? nbOutput[0] : nbOutput);
        if (!nanoBananaUrl.startsWith('http')) {
          throw new Error(`Unexpected output: ${nanoBananaUrl.substring(0, 60)}`);
        }
      } catch (err) {
        throw new Error(`Nano Banana error: ${err.message}`);
      }

      await downloadFile(nanoBananaUrl, restoredJpg);
      await sharp(restoredJpg).png().toFile(restoredPng);
      await sharp(restoredJpg).tiff({ compression: 'lzw' }).toFile(restoredTiff);

      results.push({
        originalName: cleanName,
        inputPath: file.path,
        inputSizeBytes: file.size,
        restoredPng,
        restoredJpg,
        restoredTiff,
      });

      console.log(`Step 1 image ${idx + 1} completed in ${((Date.now() - imgT0) / 1000).toFixed(1)}s`);
    }

    const nowIso = new Date().toISOString();
    const metaPath = path.join(jobDir, 'metadata.json');
    const meta = {
      jobId,
      service: 1,
      stage: 'restoration_complete',
      pipeline: 'google/nano-banana-2 -> nightmareai/real-esrgan x4',
      processedAt: nowIso,
      step1CompletedAt: nowIso,
      upscaleCompleted: false,
      imageCount: results.length,
      prompt: userPrompt,
      images: results.map(result => ({
        originalName: result.originalName,
        inputUrl: `/uploads/${path.basename(result.inputPath)}`,
        inputSizeKB: Math.round(result.inputSizeBytes / 1024),
        restoredUrl: relOutputUrl(jobId, result.restoredPng),
        restoredJpgUrl: relOutputUrl(jobId, result.restoredJpg),
        restoredTiffUrl: relOutputUrl(jobId, result.restoredTiff),
      })),
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const outputFiles = [];
    for (const [idx, result] of results.entries()) {
      outputFiles.push(
        { label: `Image ${idx + 1} - PNG (Nano Banana)`, url: relOutputUrl(jobId, result.restoredPng), ext: 'png' },
        { label: `Image ${idx + 1} - JPG (Nano Banana)`, url: relOutputUrl(jobId, result.restoredJpg), ext: 'jpg' },
        { label: `Image ${idx + 1} - TIFF (Nano Banana)`, url: relOutputUrl(jobId, result.restoredTiff), ext: 'tiff' },
      );
    }
    outputFiles.push({ label: 'Process Metadata (JSON)', url: relOutputUrl(jobId, metaPath), ext: 'json' });

    if (job && job.save) {
      try {
        job.status = 'done';
        job.outputFiles = outputFiles;
        job.completedAt = new Date();
        job.metadata = meta;
        await job.save();
      } catch {}
    }

    console.log(`SERVICE 1 STEP 1 DONE | ${results.length} image(s) | ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    return res.json({
      success: true,
      step: 1,
      jobId,
      canUpscale: true,
      outputFiles,
      images: results.map(result => ({
        originalName: result.originalName,
        inputUrl: `/uploads/${path.basename(result.inputPath)}`,
        restoredUrl: relOutputUrl(jobId, result.restoredPng),
        restoredJpgUrl: relOutputUrl(jobId, result.restoredJpg),
        restoredTiffUrl: relOutputUrl(jobId, result.restoredTiff),
      })),
    });
  } catch (err) {
    console.error('[S1] Fatal error:', err);
    if (job && job.save) {
      try {
        job.status = 'failed';
        job.error = err.message;
        await job.save();
      } catch {}
    }
    return res.status(500).json({ error: err.message || 'Processing failed.' });
  }
});

router.post('/upscale/:jobId', express.json(), async (req, res) => {
  const { jobId } = req.params;
  const jobDir = path.join(OUTPUTS_DIR, jobId);
  const metaPath = path.join(jobDir, 'metadata.json');

  if (!fs.existsSync(jobDir)) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const meta = readJsonIfExists(metaPath);
  if (!meta || !Array.isArray(meta.images) || meta.images.length === 0) {
    return res.status(400).json({ error: 'No restored images found for this job.' });
  }

  const imagesToUpscale = (req.body && Array.isArray(req.body.images) && req.body.images.length)
    ? req.body.images
    : meta.images.map((img, index) => ({ index, restoredUrl: img.restoredUrl }));

  try {
    const results = [];
    const t0 = Date.now();

    console.log('\n' + '='.repeat(60));
    console.log(`SERVICE 1 STEP 2 STARTED | job: ${jobId}`);
    console.log(`Images: ${imagesToUpscale.length}`);
    console.log('='.repeat(60));

    for (const [i, item] of imagesToUpscale.entries()) {
      const idx = item.index !== undefined ? Number(item.index) : i;
      const metaImage = meta.images[idx] || {};
      const restoredUrl = item.restoredUrl || metaImage.restoredUrl;
      if (!restoredUrl) throw new Error(`Missing restored image for index ${idx}`);

      const localRestoredPath = publicPathFromUrl(restoredUrl);
      if (!fs.existsSync(localRestoredPath)) {
        throw new Error(`Restored image not found on disk for index ${idx + 1}`);
      }

      const imgT0 = Date.now();
      const baseName = `image_${String(idx + 1).padStart(2, '0')}`;
      const outputPng = path.join(jobDir, `${baseName}_upscaled.png`);
      const outputJpg = path.join(jobDir, `${baseName}_upscaled.jpg`);
      const outputTiff = path.join(jobDir, `${baseName}_upscaled.tiff`);

      console.log(`Processing step 2 image ${idx + 1}/${imagesToUpscale.length}: ${metaImage.originalName || baseName}`);

      const restoredBuf = await toPngBuffer(localRestoredPath);
      const restoredDataUrl = toDataURL(restoredBuf);

      let esrUrl;
      try {
        const esrOutput = await replicate.run('nightmareai/real-esrgan', {
          input: { image: restoredDataUrl, scale: 4, face_enhance: false },
        });
        esrUrl = String(esrOutput);
        if (!esrUrl.startsWith('http')) {
          throw new Error(`Unexpected output: ${esrUrl.substring(0, 60)}`);
        }
      } catch (err) {
        throw new Error(`Real-ESRGAN error: ${err.message}`);
      }

      await downloadFile(esrUrl, outputPng);
      await sharp(outputPng).jpeg({ quality: 95 }).toFile(outputJpg);
      await sharp(outputPng).tiff({ compression: 'lzw' }).toFile(outputTiff);

      results.push({
        index: idx,
        originalName: metaImage.originalName || `Image ${idx + 1}`,
        inputUrl: metaImage.inputUrl,
        inputPath: publicPathFromUrl(metaImage.inputUrl),
        inputSizeBytes: (metaImage.inputSizeKB || 0) * 1024,
        restoredUrl,
        outputPng,
        outputJpg,
        outputTiff,
      });

      console.log(`Step 2 image ${idx + 1} completed in ${((Date.now() - imgT0) / 1000).toFixed(1)}s`);
    }

    const pdfPath = path.join(jobDir, 'before_after_report.pdf');
    await buildPdfReport(results, pdfPath);

    const docxPath = path.join(jobDir, 'description.docx');
    await buildWordDoc(results, docxPath);

    const updatedMeta = {
      ...meta,
      stage: 'upscale_complete',
      processedAt: new Date().toISOString(),
      step2CompletedAt: new Date().toISOString(),
      upscaleCompleted: true,
      images: meta.images.map((img, index) => {
        const upscaled = results.find(result => result.index === index);
        if (!upscaled) return img;
        return {
          ...img,
          upscaledUrl: relOutputUrl(jobId, upscaled.outputPng),
          upscaledJpgUrl: relOutputUrl(jobId, upscaled.outputJpg),
          upscaledTiffUrl: relOutputUrl(jobId, upscaled.outputTiff),
        };
      }),
    };
    fs.writeFileSync(metaPath, JSON.stringify(updatedMeta, null, 2));

    const outputFiles = [];
    for (const result of results) {
      outputFiles.push(
        { label: `Image ${result.index + 1} - PNG (Real-ESRGAN x4)`, url: relOutputUrl(jobId, result.outputPng), ext: 'png' },
        { label: `Image ${result.index + 1} - JPG (Real-ESRGAN x4)`, url: relOutputUrl(jobId, result.outputJpg), ext: 'jpg' },
        { label: `Image ${result.index + 1} - TIFF (Real-ESRGAN x4)`, url: relOutputUrl(jobId, result.outputTiff), ext: 'tiff' },
      );
    }
    outputFiles.push(
      { label: 'Before / After Report (PDF)', url: relOutputUrl(jobId, pdfPath), ext: 'pdf' },
      { label: 'Enhancement Description (Word)', url: relOutputUrl(jobId, docxPath), ext: 'docx' },
      { label: 'Process Metadata (JSON)', url: relOutputUrl(jobId, metaPath), ext: 'json' },
    );

    if (Job) {
      try {
        const job = await Job.findOne({ jobId });
        if (job) {
          job.status = 'done';
          job.outputFiles = outputFiles;
          job.completedAt = new Date();
          job.metadata = updatedMeta;
          await job.save();
        }
      } catch {}
    }

    console.log(`SERVICE 1 STEP 2 DONE | ${results.length} image(s) | ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    return res.json({
      success: true,
      step: 2,
      jobId,
      outputFiles,
      images: results.map(result => ({
        index: result.index,
        originalName: result.originalName,
        inputUrl: result.inputUrl,
        restoredUrl: result.restoredUrl,
        upscaledUrl: relOutputUrl(jobId, result.outputPng),
        upscaledJpgUrl: relOutputUrl(jobId, result.outputJpg),
        upscaledTiffUrl: relOutputUrl(jobId, result.outputTiff),
      })),
    });
  } catch (err) {
    console.error('[S1/UPSCALE] Fatal error:', err);
    return res.status(500).json({ error: err.message || 'Upscaling failed.' });
  }
});

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

// Backward-compatible extra enhancement route kept as-is for existing clients.
router.post('/enhance/:jobId', express.json(), async (req, res) => {
  const { jobId } = req.params;
  const jobDir = path.join(OUTPUTS_DIR, jobId);

  if (!fs.existsSync(jobDir)) {
    return res.status(404).json({ error: 'Job not found - invalid jobId' });
  }

  const imagesToEnhance = req.body && req.body.images;
  if (!imagesToEnhance || !imagesToEnhance.length) {
    return res.status(400).json({ error: 'No images provided' });
  }

  const userPrompt = (req.body.prompt || '').trim() ||
    'Heritage building restoration, high-resolution architectural photography, photorealistic, detailed stone textures, preserved historical details';

  try {
    const results = [];

    for (const [i, item] of imagesToEnhance.entries()) {
      const idx = item.index !== undefined ? item.index : i;
      const esrUrl = item.esrganUrl;
      const localPath = path.join(__dirname, '../../public', esrUrl);
      let controlImage;

      if (fs.existsSync(localPath)) {
        const buf = await toPngBuffer(localPath);
        controlImage = toDataURL(buf);
      } else {
        controlImage = `http://localhost:${process.env.PORT || 3000}${esrUrl}`;
      }

      let fluxUrl;
      try {
        const output = await replicate.run('black-forest-labs/flux-canny-pro', {
          input: {
            control_image: controlImage,
            prompt: userPrompt,
            steps: 28,
            guidance: 7.5,
            output_format: 'png',
            output_quality: 95,
          },
        });
        fluxUrl = String(output);
        if (!fluxUrl.startsWith('http')) throw new Error(`Unexpected output: ${fluxUrl.substring(0, 60)}`);
      } catch (e) {
        throw new Error(`Flux Canny Pro error: ${e.message}`);
      }

      const baseName = `image_${String(idx + 1).padStart(2, '0')}`;
      const fluxPng = path.join(jobDir, `${baseName}_flux.png`);
      const fluxJpg = path.join(jobDir, `${baseName}_flux.jpg`);
      const fluxTiff = path.join(jobDir, `${baseName}_flux.tiff`);
      await downloadFile(fluxUrl, fluxPng);
      await sharp(fluxPng).jpeg({ quality: 95 }).toFile(fluxJpg);
      await sharp(fluxPng).tiff({ compression: 'lzw' }).toFile(fluxTiff);

      results.push({
        index: idx,
        esrganUrl: esrUrl,
        fluxUrl: relOutputUrl(jobId, fluxPng),
        outputs: [
          { label: `Image ${idx + 1} - PNG (Flux Canny Pro)`, url: relOutputUrl(jobId, fluxPng), ext: 'png' },
          { label: `Image ${idx + 1} - JPG (Flux Canny Pro)`, url: relOutputUrl(jobId, fluxJpg), ext: 'jpg' },
          { label: `Image ${idx + 1} - TIFF (Flux Canny Pro)`, url: relOutputUrl(jobId, fluxTiff), ext: 'tiff' },
        ],
      });
    }

    return res.json({ success: true, jobId, results });
  } catch (err) {
    console.error('[Flux Canny Pro] Fatal error:', err.message);
    return res.status(500).json({ error: err.message || 'Flux Canny Pro processing failed' });
  }
});

module.exports = router;
