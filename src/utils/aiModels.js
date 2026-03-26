const AI_MODEL_CATALOG = {
  gpt: {
    id: 'gpt',
    label: 'GPT 5',
    provider: 'replicate',
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    defaultApiModel: 'openai/gpt-5',
    genericModelEnv: 'OPENAI_REPORT_MODEL',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini 3.1 Pro',
    provider: 'replicate',
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    defaultApiModel: 'google/gemini-3.1-pro',
    genericModelEnv: 'GEMINI_REPORT_MODEL',
  },
  claude: {
    id: 'claude',
    label: 'Claude Sonnet 4.5',
    provider: 'replicate',
    apiKeyEnv: 'REPLICATE_API_TOKEN',
    defaultApiModel: 'anthropic/claude-4.5-sonnet',
    genericModelEnv: 'CLAUDE_REPORT_MODEL',
  },
};

const AI_MODEL_INPUT_MAP = {
  gpt: 'gpt',
  GPT: 'gpt',
  'gpt 5': 'gpt',
  'GPT 5': 'gpt',
  'gemini 3.1 pro': 'gemini',
  'Gemini 3.1 Pro': 'gemini',
  gemini: 'gemini',
  'claude sonnet 4.5': 'claude',
  'Claude Sonnet 4.5': 'claude',
  'claude sonnet 4.6': 'claude',
  'Claude Sonnet 4.6': 'claude',
  claude: 'claude',
};

function normalizeAiModel(value, fallback = 'gpt') {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (!normalized) return fallback;
  return AI_MODEL_INPUT_MAP[normalized] || AI_MODEL_INPUT_MAP[normalized.toLowerCase()] || fallback;
}

function getAiModelLabel(value, fallback = 'gpt') {
  const key = normalizeAiModel(value, fallback);
  return AI_MODEL_CATALOG[key]?.label || AI_MODEL_CATALOG[fallback]?.label || 'GPT 5';
}

function resolveAiModelDescriptor(value, options = {}) {
  const key = normalizeAiModel(value, options.fallback || 'gpt');
  const base = AI_MODEL_CATALOG[key] || AI_MODEL_CATALOG.gpt;
  const overrideMap = options.modelOverrides || {};
  const apiModel = overrideMap[key]
    || process.env[base.genericModelEnv]
    || base.defaultApiModel;

  return {
    ...base,
    selectedKey: key,
    selectedLabel: base.label,
    apiModel,
  };
}

module.exports = {
  AI_MODEL_CATALOG,
  normalizeAiModel,
  getAiModelLabel,
  resolveAiModelDescriptor,
};
