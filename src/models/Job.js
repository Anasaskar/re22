const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  jobId:       { type: String, required: true, unique: true },
  service:     { type: Number, default: 1 },
  status:      { type: String, enum: ['pending','processing','done','failed'], default: 'pending' },
  inputFiles:  [{ originalName: String, storedPath: String, sizeBytes: Number }],
  outputFiles: [{ label: String, path: String, url: String }],
  metadata:    { type: mongoose.Schema.Types.Mixed, default: {} },
  error:       { type: String },
  createdAt:   { type: Date, default: Date.now },
  completedAt: { type: Date },
});

module.exports = mongoose.model('Job', jobSchema);
