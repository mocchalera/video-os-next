// Run from the repository root with Node --env-file=.env.local.
// This task is authorized for Gemini 3.8 TTS only, up to USD 1 in total.
// No automatic retries: inspect each saved response before another attempt.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const key = process.env.GEMINI_API_KEY?.trim();
if (!key) throw new Error('GEMINI_API_KEY is missing.');
const requestText = fs.readFileSync(path.join(root, 'data/tts-request.json'), 'utf8');
const request = JSON.parse(requestText);
if (request.model !== 'gemini-3.8-flash-tts') throw new Error('Requested model must remain Gemini 3.8 Flash TTS.');
const research = path.join(root, 'research');
fs.mkdirSync(research, { recursive: true });
const ledgerFile = path.join(research, 'tts-budget.json');
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8')) : {
  authorized_usd: 1,
  pricing_date: '2026-09-30',
  input_usd_per_million: 0.5,
  output_usd_per_million: 9,
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  attempts: [],
};
// The published serving limits are 8192 input and 16384 output tokens.
// USD .16 reserves the maximum standard-price charge for a complete call.
const reservation = 0.16;
const reserved = ledger.attempts.reduce((n, a) => n + a.reserved_usd, 0);
if (reserved + reservation > ledger.authorized_usd) throw new Error('Authorized USD 1 budget would be exceeded.');
const attemptNumber = ledger.attempts.length + 1;
const prefix = `gemini-tts-${String(attemptNumber).padStart(2, '0')}`;
const attempt = {
  number: attemptNumber, model: request.model,
  voice: request.generation_config.speech_config[0].voice,
  request_sha256: createHash('sha256').update(requestText).digest('hex'),
  reserved_usd: reservation, state: 'request-started',
  started: new Date().toISOString(),
};
ledger.attempts.push(attempt);
const saveLedger = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
saveLedger();
console.log(JSON.stringify({ state: attempt.state, attempt: attemptNumber, model: request.model, reserved_usd: reservation, total_reserved_usd: reserved + reservation }));
try {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: requestText, signal: AbortSignal.timeout(900_000),
  });
  const raw = await response.text();
  const responseFile = path.join(research, `${prefix}.response.json`);
  fs.writeFileSync(responseFile, raw, { mode: 0o600, flag: 'wx' });
  attempt.http_status = response.status;
  attempt.response_file = `research/${prefix}.response.json`;
  const result = JSON.parse(raw);
  if (!response.ok) {
    attempt.state = 'provider-error';
    attempt.error = String(result.error?.message ?? response.statusText).replaceAll(key, '[redacted]').slice(0, 700);
    saveLedger();
    console.log(JSON.stringify({ state: attempt.state, http_status: response.status, error: attempt.error }));
    process.exitCode = 1;
  } else {
    const blocks = (result.steps ?? []).filter(s => s.type === 'model_output').flatMap(s => s.content ?? []).filter(c => c.type === 'audio' && c.data);
    if (!blocks.length) throw new Error(`No audio returned; saved response ${prefix}.response.json must be inspected.`);
    const audio = Buffer.from(blocks.at(-1).data, 'base64');
    if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected a complete WAV from the documented API. Inspect response before decoding differently.');
    fs.mkdirSync(path.join(root, 'media'), { recursive: true });
    const wavName = `narration-${prefix}.wav`;
    fs.writeFileSync(path.join(root, 'media', wavName), audio, { flag: 'wx' });
    Object.assign(attempt, {
      state: 'audio-received', finished: new Date().toISOString(),
      audio_file: `media/${wavName}`, audio_bytes: audio.length,
      audio_sha256: createHash('sha256').update(audio).digest('hex'),
      interaction_id: result.id ?? null, returned_model: result.model ?? null,
      usage: result.usage ?? result.usage_metadata ?? null,
    });
    saveLedger();
    console.log(JSON.stringify(attempt));
  }
} catch (error) {
  attempt.state = 'outcome-needs-inspection';
  attempt.error = String(error.message ?? error).replaceAll(key, '[redacted]').slice(0, 500);
  saveLedger();
  console.error(JSON.stringify({ state: attempt.state, error: attempt.error }));
  process.exitCode = 1;
}
