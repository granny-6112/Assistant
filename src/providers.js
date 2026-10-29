// The models the slider can pick from, and one streaming call per provider.
// Conversation history is kept provider-neutral (Anthropic-style content
// blocks holding text and base64 JPEGs), so you can slide to another model in
// the middle of a conversation and it still sees what came before.
// Both SDKs load on first use, not at startup: Assistant starts faster and
// stays lighter while it sits in the background.
let anthropicSdk = null;
let googleSdk = null;
const Anthropic = () => (anthropicSdk ||= require('@anthropic-ai/sdk'));
const GoogleGenAI = () => (googleSdk ||= require('@google/genai')).GoogleGenAI;
// Error checks never load an SDK: if it isn't loaded yet, the error can't be its.
function loadedSdk(id) {
  try {
    return require.cache[require.resolve(id)] ? require(id) : null;
  } catch {
    return null;
  }
}
const isGoogleErr = (err) => { const g = loadedSdk('@google/genai'); return Boolean(g) && err instanceof g.ApiError; };
const isAnthropicErr = (err, kind = 'APIError') => { const a = loadedSdk('@anthropic-ai/sdk'); return Boolean(a) && err instanceof a[kind]; };
const local = require('./local');
const usage = require('./usage');

const SYSTEM_PROMPT = `You are Assistant, a helper that lives in a bar at the top of the user's Windows desktop.
When the user's message includes a screenshot, it shows their screen at the moment they asked; frames from a screen recording are labelled with their timestamps.
Answer about what is actually visible: name the app, window, text, code or error you are referring to, and say so plainly when something is too small or cut off to read.
Be direct and concise. Lead with the answer, then the detail that supports it. Use short Markdown (lists, code blocks) when it helps; skip preamble.`;

// Ordered for the slider: offline first, then cloud models from fastest to smartest.
const MODELS = [
  { id: 'local', provider: 'local', label: 'Offline', name: 'Gemma 4 on this PC', note: 'Runs on your laptop with no internet and no key. Slower and less capable than the cloud models.' },
  { id: 'gemini-3.5-flash-lite', provider: 'google', label: 'Fast', name: 'Gemini 3.5 Flash-Lite', note: 'Quickest answers. Free with a Google AI Studio key.' },
  { id: 'gemini-3.6-flash', provider: 'google', label: 'Balanced', name: 'Gemini 3.6 Flash', note: 'Good all-rounder. Free with a Google AI Studio key.' },
  { id: 'gemini-3.8-flash', provider: 'google', label: 'Smart', name: 'Gemini 3.8 Flash', note: "Google's smartest free model." },
  { id: 'gemini-4-argon', provider: 'google', label: 'Max', name: 'Gemini 4 Argon', note: "Google's flagship. Not on the free tier: needs billing turned on for your key." },
  { id: 'claude-opus-5-5', provider: 'anthropic', label: 'Claude', name: 'Claude Opus 5.5', note: 'Needs a paid Anthropic API key.' },
];
const DEFAULT_MODEL = 'gemini-3.8-flash';

const PROVIDERS = {
  local: { name: 'the offline model', envVars: [] },
  google: { name: 'Google AI Studio', keyUrl: 'https://aistudio.google.com/apikey', envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  anthropic: { name: 'Anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', envVars: ['ANTHROPIC_API_KEY'] },
};

function findModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL);
}

// ---------- Claude ----------

// Models that accept server-side refusal fallbacks with fallbacks: "default".
const CLAUDE_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const anthropicClients = new Map();

async function streamClaude({ apiKey, model, effort, messages, signal, onText, onFallback }) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new (Anthropic())({ apiKey }));
  const client = anthropicClients.get(apiKey);
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages,
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
  };
  if (CLAUDE_FALLBACK_MODELS.has(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params, { signal });
  let text = '';
  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
      onFallback?.();
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      onText(event.delta.text);
    }
  }
  const message = await stream.finalMessage();
  return {
    refused: message.stop_reason === 'refusal',
    truncated: message.stop_reason === 'max_tokens',
    servedBy: message.model,
    text,
  };
}

// ---------- Gemini ----------

const googleClients = new Map();

function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.content.map((b) => (b.type === 'image'
      ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
      : { text: b.text })),
  }));
}

const GEMINI_BLOCKED = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']);

async function streamGemini({ apiKey, model, messages, signal, onText }) {
  if (!googleClients.has(apiKey)) googleClients.set(apiKey, new (GoogleGenAI())({ apiKey }));
  const ai = googleClients.get(apiKey);
  usage.count(model);
  const stream = await ai.models.generateContentStream({
    model,
    contents: toGeminiContents(messages),
    config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 16000, abortSignal: signal },
  });
  let text = '';
  let finishReason = null;
  let blocked = false;
  for await (const chunk of stream) {
    if (signal?.aborted) throw abortError();
    if (chunk.promptFeedback?.blockReason) blocked = true;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts || []) {
      if (part.text && !part.thought) {
        text += part.text;
        onText(part.text);
      }
    }
  }
  return {
    refused: blocked || GEMINI_BLOCKED.has(finishReason),
    truncated: finishReason === 'MAX_TOKENS',
    servedBy: model,
    text,
  };
}

// Google's free tier answers 503 ("model overloaded") or 429 (quota) at busy
// times. Retry the same model briefly, then step down to a lighter Gemini model,
// but only before any text has streamed, so an answer is never stitched together.
const GEMINI_RETRY_DELAYS_MS = [1000, 3000];
const GEMINI_FALLBACK_ORDER = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

// What kind of limit a Gemini 429 is: the free day's quota or a per-minute cap.
function geminiLimit(err) {
  const msg = err?.message || '';
  const retry = msg.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/);
  return {
    perDay: /PerDay/i.test(msg),
    retrySeconds: retry ? Math.ceil(Number(retry[1])) : null,
  };
}

function isGeminiBusy(err) {
  return isGoogleErr(err) && (err.status === 503 || err.status === 429 || err.status === 500);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

async function streamGeminiResilient(args) {
  const start = GEMINI_FALLBACK_ORDER.indexOf(args.model);
  const chain = start >= 0 ? GEMINI_FALLBACK_ORDER.slice(start) : [args.model, ...GEMINI_FALLBACK_ORDER];
  let lastErr;
  for (const [i, model] of chain.entries()) {
    if (i > 0) args.onBusy?.(`${findModel(chain[i - 1]).name} is busy, trying ${findModel(model).name}…`);
    for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt++) {
      let streamed = false;
      try {
        const result = await streamGemini({ ...args, model, onText: (t) => {
          if (!streamed && (i > 0 || attempt > 0)) args.onBusy?.(null);
          streamed = true;
          args.onText(t);
        } });
        if (model !== args.model) result.busyFallback = findModel(model).name;
        return result;
      } catch (err) {
        if (streamed || !isGeminiBusy(err)) throw err;
        lastErr = err;
        if (err.status === 429 && geminiLimit(err).perDay) usage.hitDailyLimit(model);
        // A spent quota won't recover in seconds: move straight to the next model.
        if (err.status === 429 || attempt === GEMINI_RETRY_DELAYS_MS.length) break;
        args.onBusy?.(`${findModel(model).name} is busy, retrying…`);
        await sleep(GEMINI_RETRY_DELAYS_MS[attempt], args.signal);
      }
    }
  }
  throw lastErr;
}

// Speech to text for the mic button, with Gemini (free key). Tries the light
// model first and steps up if it is busy.
async function transcribe(apiKey, wavBase64, { partial = false } = {}) {
  if (!googleClients.has(apiKey)) googleClients.set(apiKey, new (GoogleGenAI())({ apiKey }));
  const ai = googleClients.get(apiKey);
  let lastErr;
  // Live previews use the fastest model only; the final pass can fall back.
  for (const model of partial ? ['gemini-3.5-flash-lite'] : ['gemini-3.5-flash-lite', 'gemini-3.6-flash']) {
    try {
      usage.count(model);
      const res = await ai.models.generateContent({
        model,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
            { text: 'Transcribe this speech exactly as spoken, in the language spoken, with normal punctuation. Reply with only the transcript. If there is no speech, reply with nothing.' },
          ],
        }],
        config: { maxOutputTokens: 2000 },
      });
      return (res.text || '').trim();
    } catch (err) {
      lastErr = err;
      if (!isGeminiBusy(err)) break;
    }
  }
  throw lastErr;
}

function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

// ---------- conversation ----------

class Conversation {
  constructor() {
    this.history = [];
    this.controller = null;
  }

  reset() {
    this.cancel();
    this.history = [];
  }

  cancel() {
    if (this.controller) this.controller.abort();
    this.controller = null;
  }

  async ask({ model, apiKey, effort, localTier, content, onText, onFallback, onBusy }) {
    const userTurn = { role: 'user', content };
    const controller = new AbortController();
    this.controller = controller;
    const args = { apiKey, model: model.id, effort, messages: [...this.history, userTurn], signal: controller.signal, onText, onFallback, onBusy };
    try {
      let result;
      if (model.provider === 'anthropic') result = await streamClaude(args);
      else if (model.provider === 'google') result = await streamGeminiResilient(args);
      else result = await local.streamLocal({ ...args, tierSetting: localTier, systemPrompt: SYSTEM_PROMPT });
      if (!result.refused) {
        // Append only complete answers, so a cancelled or failed turn leaves no trace.
        this.history.push(userTurn, { role: 'assistant', content: [{ type: 'text', text: result.text || '(no answer)' }] });
      }
      return result;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

// Checks a key with a free metadata call (no tokens used), so the user knows
// straight away whether it works instead of finding out on their first question.
async function verifyKey(provider, apiKey) {
  try {
    if (provider === 'google') {
      await new (GoogleGenAI())({ apiKey }).models.get({ model: DEFAULT_MODEL });
    } else {
      await new (Anthropic())({ apiKey }).models.list({ limit: 1 });
    }
    return { valid: true };
  } catch (err) {
    const status = err?.status;
    if (status === 400 || status === 401 || status === 403) {
      return { valid: false, message: `${PROVIDERS[provider].name} says this key isn't valid. Copy it again from ${PROVIDERS[provider].keyUrl.replace('https://', '')} and paste the whole thing.` };
    }
    // Offline or a temporary error: keep the key and let the first question tell.
    return { valid: null, message: "Saved, but couldn't check it right now (no connection?)." };
  }
}

function isAbort(err) {
  return isAnthropicErr(err, 'APIUserAbortError') || err?.name === 'AbortError';
}

const NETWORK = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket hang up/i;

// Every message says what happened and what to do next, in plain words.
function describeError(err, model) {
  const msg = err?.message || String(err);
  if (model.provider === 'local') {
    if (NETWORK.test(msg)) return 'The offline model has to download once before it works offline, and there is no internet right now. Connect and try again, or slide to a cloud model.';
    if (/out of memory|alloc|ENOMEM/i.test(msg)) return 'Your PC ran out of memory loading the offline model. Close some apps, or pick the Small size in Settings → LLM settings.';
    if (/ENOSPC|no space/i.test(msg)) return 'Not enough disk space for the offline model. Free up a few GB and try again.';
    return `The offline model hit a problem: ${msg}. Try again; if it keeps happening, pick a smaller size in Settings → LLM settings.`;
  }
  if (NETWORK.test(msg) && !(isGoogleErr(err)) && !(isAnthropicErr(err, 'APIError') && err.status)) {
    return "You're offline, or the internet connection dropped. Check your Wi-Fi and try again, or slide to Offline.";
  }
  if (isGoogleErr(err)) {
    const s = err.status;
    if (s === 401 || (s === 400 && /api key|API_KEY/i.test(msg))) return 'Google rejected your key. Open Settings → API keys and paste a fresh one from aistudio.google.com/apikey.';
    if (s === 429) {
      const lim = geminiLimit(err);
      if (lim.perDay) return `You've used today's free Gemini allowance on every model. It resets at ${usage.resetTime()} your time. Until then, slide to Offline (or add billing to your Google key).`;
      return `Google's free tier allows only a few requests a minute and you've hit that. Wait ${lim.retrySeconds ? `${lim.retrySeconds} seconds` : 'a minute'} and ask again.`;
    }
    if (s === 503 || s === 500 || s === 504) return "Google's free Gemini servers are overloaded right now. Every free model was tried. Wait a minute and ask again, or slide to Offline.";
    if (s === 403) return model.id === 'gemini-4-argon'
      ? 'Gemini 4 Argon is not on the free tier. Turn on billing for your key in Google AI Studio, or slide to Smart.'
      : `Your Google key isn't allowed to use ${model.name}. Check the key in Google AI Studio, or slide to another model.`;
    if (s === 404) return `${model.name} isn't available to your key (Google may have renamed or retired it). Slide to another model.`;
    if (s === 400 && /too large|exceeds|size|payload/i.test(msg)) return 'That was too much for Gemini in one go (usually a very large screenshot or recording). Turn screenshot detail down to Standard, or ask without the recording.';
    if (s === 400) return `Gemini couldn't process that request. Try asking again, or without the screenshot. (Google said: ${msg.slice(0, 160)})`;
    return `Google returned an unexpected error (${s}). Try again in a moment, or slide to another model.`;
  }
  if (isAnthropicErr(err, 'AuthenticationError')) return 'Anthropic rejected your key. Open Settings → API keys and paste a fresh one from console.anthropic.com.';
  if (isAnthropicErr(err, 'PermissionDeniedError')) return `Your Anthropic key can't use ${model.name}. Check your account at console.anthropic.com.`;
  if (isAnthropicErr(err, 'NotFoundError')) return `${model.name} wasn't found. Slide to another model.`;
  if (isAnthropicErr(err, 'RateLimitError')) return "You're sending Claude requests faster than your Anthropic plan allows. Wait a minute and try again.";
  if (isAnthropicErr(err, 'BadRequestError') && /credit balance/i.test(msg)) return 'Your Anthropic account is out of credit. Top up at console.anthropic.com → Billing, or slide to a Gemini model.';
  if (isAnthropicErr(err, 'BadRequestError')) return `Claude couldn't process that request. Try again, or without the screenshot. (Anthropic said: ${msg.slice(0, 160)})`;
  if (isAnthropicErr(err, 'InternalServerError') || err?.status === 529) return 'Claude is overloaded right now. Wait a minute and try again, or slide to a Gemini model.';
  if (isAnthropicErr(err, 'APIConnectionError')) return "Couldn't reach Anthropic. Check your internet connection and try again.";
  if (isAnthropicErr(err, 'APIError')) return `Anthropic returned an unexpected error (${err.status ?? 'unknown'}). Try again in a moment.`;
  return `Something went wrong: ${msg}. Try again; if it keeps happening, start a new chat with the + button.`;
}

module.exports = { transcribe, MODELS, DEFAULT_MODEL, PROVIDERS, findModel, Conversation, describeError, isAbort, verifyKey };
