let Replicate;
try {
  Replicate = require('replicate');
} catch (error) {
  Replicate = null;
}

const { resolveAiModelDescriptor } = require('./aiModels');

const STRUCTURED_GPT_API_MODEL = 'openai/gpt-5-structured';
const STRUCTURED_GPT_BASE_MODEL = 'gpt-5';

function normalizeReplicateText(output) {
  if (Array.isArray(output)) {
    return output.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('').trim();
  }
  if (typeof output === 'string') return output.trim();
  if (!output || typeof output !== 'object') return '';

  if (typeof output.text === 'string') return output.text.trim();
  if (typeof output.output_text === 'string') return output.output_text.trim();
  if (typeof output.response === 'string') return output.response.trim();
  if (Array.isArray(output.output)) return normalizeReplicateText(output.output);
  if (Array.isArray(output.content)) {
    return output.content
      .map(part => typeof part?.text === 'string' ? part.text : '')
      .join('')
      .trim();
  }
  return JSON.stringify(output);
}

async function withTimeout(promise, timeoutMs, message) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || `Replicate request timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildReplicateAttempts(systemPrompt, userPrompt, descriptor, options = {}) {
  const temperature = options.temperature ?? 0.3;
  const maxTokens = options.maxTokens ?? 4000;
  const promptOnly = `${systemPrompt}\n\n${userPrompt}`;
  const structuredJsonSchema = options.jsonSchema
    ? {
        format: {
          type: 'json_schema',
          name: options.schemaName || 'structured_output',
          schema: options.jsonSchema,
        },
      }
    : null;

  if (descriptor.selectedKey === 'gpt') {
    const baseInput = {
      reasoning_effort: options.reasoningEffort || 'minimal',
      verbosity: options.verbosity || 'low',
      max_output_tokens: maxTokens,
    };
    const structuredInput = structuredJsonSchema && String(descriptor.apiModel || '').includes('gpt-5-structured')
      ? {
          model: options.structuredModel || STRUCTURED_GPT_BASE_MODEL,
          json_schema: structuredJsonSchema,
        }
      : {};

    return [
      {
        apiModel: descriptor.apiModel,
        input: {
          ...baseInput,
          ...structuredInput,
          instructions: systemPrompt,
          prompt: userPrompt,
        },
      },
      {
        apiModel: descriptor.apiModel,
        input: {
          ...baseInput,
          ...structuredInput,
          prompt: promptOnly,
        },
      },
    ];
  }

  if (descriptor.selectedKey === 'gemini') {
    return [
      {
        apiModel: descriptor.apiModel,
        input: {
          system_instruction: systemPrompt,
          prompt: userPrompt,
          temperature,
          thinking_level: options.thinkingLevel || 'medium',
          max_output_tokens: maxTokens,
        },
      },
      {
        apiModel: descriptor.apiModel,
        input: {
          prompt: promptOnly,
          temperature,
          max_output_tokens: maxTokens,
        },
      },
    ];
  }

  if (descriptor.selectedKey === 'claude') {
    return [
      {
        apiModel: descriptor.apiModel,
        input: {
          system_prompt: systemPrompt,
          prompt: userPrompt,
          temperature,
          max_tokens: maxTokens,
        },
      },
      {
        apiModel: descriptor.apiModel,
        input: {
          prompt: promptOnly,
          temperature,
          max_tokens: maxTokens,
        },
      },
    ];
  }

  return [
    {
      apiModel: descriptor.apiModel,
      input: {
        system_prompt: systemPrompt,
        prompt: userPrompt,
        temperature,
        max_completion_tokens: maxTokens,
      },
    },
    {
      apiModel: descriptor.apiModel,
      input: {
        prompt: promptOnly,
        temperature,
        max_completion_tokens: maxTokens,
      },
    },
    {
      apiModel: descriptor.apiModel,
      input: {
        system_prompt: systemPrompt,
        prompt: userPrompt,
        temperature,
        max_tokens: maxTokens,
      },
    },
  ];
}

async function generateWithReplicate(systemPrompt, userPrompt, descriptor, options = {}) {
  if (!Replicate || !process.env.REPLICATE_API_TOKEN) {
    throw new Error(`Missing ${descriptor.apiKeyEnv}.`);
  }

  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  const attempts = buildReplicateAttempts(systemPrompt, userPrompt, descriptor, options);
  const failures = [];

  for (const attempt of attempts) {
    try {
      const output = await withTimeout(
        replicate.run(attempt.apiModel, { input: attempt.input }),
        options.timeoutMs,
        `${descriptor.selectedLabel || descriptor.apiModel} request timed out after ${options.timeoutMs}ms.`,
      );
      const text = normalizeReplicateText(output);
      if (!text) throw new Error('Replicate returned an empty response.');
      return {
        provider: 'replicate',
        model: attempt.apiModel,
        text,
      };
    } catch (error) {
      failures.push(`${attempt.apiModel}: ${error.message}`);
    }
  }

  throw new Error(failures.join(' | '));
}

async function repairStructuredJson(rawText, descriptor, parseJson, options = {}) {
  const repairSystem = [
    'You repair malformed JSON responses.',
    'Return valid JSON only.',
    'Preserve the original keys, values, order, and wording whenever possible.',
    'Only fix escaping, commas, brackets, quotes, duplicated fences, and similar JSON formatting problems.',
    'Do not add commentary or markdown.',
  ].join(' ');

  const repairUser = [
    'Repair this malformed JSON so it becomes valid JSON without changing the intended content.',
    rawText,
  ].join('\n\n');

  const repairDescriptor = options.jsonSchema
    ? {
        ...resolveAiModelDescriptor('gpt'),
        apiModel: STRUCTURED_GPT_API_MODEL,
      }
    : descriptor;

  const repairResult = await generateWithReplicate(repairSystem, repairUser, repairDescriptor, {
    temperature: 0,
    maxTokens: Math.max(1200, Math.min(options.maxTokens ?? 4000, 6000)),
    timeoutMs: options.timeoutMs ? Math.min(options.timeoutMs, 120000) : 120000,
    jsonSchema: options.jsonSchema,
    structuredModel: STRUCTURED_GPT_BASE_MODEL,
    schemaName: 'repaired_structured_output',
  });

  return {
    provider: repairResult.provider,
    model: repairResult.model,
    json: parseJson(repairResult.text),
  };
}

async function generateStructuredJson({ aiModel, systemPrompt, userPrompt, parseJson, modelOverrides, temperature, maxTokens, timeoutMs, jsonSchema }) {
  const baseDescriptor = resolveAiModelDescriptor(aiModel, { modelOverrides });
  const descriptor = jsonSchema && baseDescriptor.selectedKey === 'gpt' && !String(baseDescriptor.apiModel || '').includes('gpt-5-structured')
    ? { ...baseDescriptor, apiModel: STRUCTURED_GPT_API_MODEL }
    : baseDescriptor;
  const result = await generateWithReplicate(systemPrompt, userPrompt, descriptor, {
    temperature,
    maxTokens,
    timeoutMs,
    jsonSchema,
    structuredModel: STRUCTURED_GPT_BASE_MODEL,
    schemaName: 'structured_output',
  });

  try {
    return {
      selectedModel: descriptor.selectedKey,
      selectedLabel: descriptor.selectedLabel,
      provider: result.provider,
      model: result.model,
      json: parseJson(result.text),
    };
  } catch (parseError) {
    const repaired = await repairStructuredJson(result.text, descriptor, parseJson, {
      maxTokens,
      timeoutMs,
      jsonSchema,
    });

    return {
      selectedModel: descriptor.selectedKey,
      selectedLabel: descriptor.selectedLabel,
      provider: repaired.provider,
      model: repaired.model,
      json: repaired.json,
    };
  }
}

module.exports = {
  generateStructuredJson,
};

