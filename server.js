const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/outputs', express.static(path.join(__dirname, 'public/outputs')));

// ── API Routes ────────────────────────────────────────────────────────────
app.use('/api/service1', require('./src/routes/service1'));

// ── Index fallback ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[APP] Unhandled error:', err.message);
    res.status(500).json({ error: err.message });
});

// ── MongoDB (optional — non-fatal) ────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/re_spa';
try {
    const mongoose = require('mongoose');
    mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
        .then(() => console.log('✅ MongoDB Connected'))
        .catch(err => console.log('⚠️  MongoDB offline (service still functional):', err.code || err.message));
} catch (e) {
    console.log('⚠️  Mongoose not available:', e.message);
}

// ── Listen ────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
    console.log(`\n🚀 Server running → http://localhost:${PORT}\n`);
});

// Catch unhandled rejections so the process doesn't crash
process.on('unhandledRejection', (reason) => {
    console.error('⚠️  Unhandled rejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️  Uncaught exception (kept alive):', err.message);
});
