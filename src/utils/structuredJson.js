const vm = require('vm');

function extractJsonCandidate(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Empty model response.');
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const jsonChunk = candidate.match(/\{[\s\S]*\}/);
  return (jsonChunk ? jsonChunk[0] : candidate).trim();
}

function sanitizeJsonCandidate(candidate) {
  return String(candidate || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function parseModelJsonObject(text) {
  const candidate = extractJsonCandidate(text);
  const sanitized = sanitizeJsonCandidate(candidate);
  const attempts = [candidate, sanitized];
  const errors = [];

  for (const value of attempts) {
    try {
      return JSON.parse(value);
    } catch (error) {
      errors.push(error.message);
    }
  }

  try {
    const repaired = vm.runInNewContext(`(${sanitized})`, Object.create(null), { timeout: 1000 });
    if (repaired && typeof repaired === 'object') {
      return JSON.parse(JSON.stringify(repaired));
    }
  } catch (error) {
    errors.push(error.message);
  }

  throw new Error(errors.join(' | '));
}

module.exports = {
  parseModelJsonObject,
};
