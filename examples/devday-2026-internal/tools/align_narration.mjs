// Align the authored captions to cached local ASR word times. No provider calls.
// First run writes an audit. --apply updates the VOS edit and exports an SRT.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignLyrics } from '../../../src/lyrics/align.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const filmPath = path.join(root, 'data/film.json');
const film = JSON.parse(fs.readFileSync(filmPath, 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8')).assets;
const asset = assets.narration;
if (!asset?.has_audio) throw new Error('Ingest the Gemini narration first.');
const transcript = JSON.parse(fs.readFileSync(path.join(root, `.vos/analysis/${asset.id}/transcript.json`), 'utf8'));
const written = [
  ['チャットジーピーティー', 'ChatGPT'], ['ジーピーティー、ろくてんいち、ソル', 'GPT-6.1 Sol'],
  ['エージェンツ、エーピーアイ', 'Agents API'], ['ディシジョンズ、エーピーアイ', 'Decisions API'],
  ['サインイン、ウィズ、チャットジーピーティー', 'Sign in with ChatGPT'],
  ['プライベートインテリジェンス', 'Private Intelligence'], ['セキュリティークラウド', 'Security Cloud'],
  ['ウルトラファスト', 'Ultrafast'], ['コンピューターユース', 'Computer Use'], ['ミーティングズ', 'Meetings'],
  ['コーデックス', 'Codex'], ['ページズ', 'Pages'], ['スラック', 'Slack'], ['チームズ', 'Teams'],
  ['ワークイン、クラウド、環境を選択', 'Work in → Cloud → Select environment'],
  ['クラウドピーシー', 'クラウドPC'], ['エーダブリューエス', 'AWS'], ['エーピーアイ', 'API'],
  ['シーエルアイ', 'CLI'], ['ギットハブ', 'GitHub'], ['ギットラボ', 'GitLab'], ['エムシーピー', 'MCP'],
  ['アストラ', 'Astra'], ['スペース', 'Space'], ['ドッツ', 'Dots'], ['ワーク', 'Work'], ['ソル', 'Sol'],
  ['デブデイ', 'DevDay'], ['エーアイ', 'AI'], ['アット、ChatGPT', '@ChatGPT'],
  ['百万トークン', '100万トークン'], ['プロ、五百ドル', 'Pro 500ドル'],
];
// ASR tokenizes Japanese names into individual characters. Compare their spoken
// forms, while preserving the readable English product names in the captions.
const spokenTerms = written.map(([a, b]) => [b, a]).concat([
  ['Private', 'プライベート'], ['Intelligence', 'インテリジェンス'],
  ['Agents', 'エージェンツ'], ['Decisions', 'ディシジョンズ'],
  ['Computer', 'コンピューター'], ['Use', 'ユース'],
  ['Business', 'ビジネス'], ['Enterprise', 'エンタープライズ'],
  ['GPT', 'ジーピーティー'], ['6.1', 'ろくてんいち'], ['Mac', 'マック'],
]).sort((a, b) => b[0].length - a[0].length);
const spoken = text => spokenTerms.reduce((s, [a, b]) => s.replaceAll(a, b), text);
const normalizeTerms = text => written.reduce((s, [a, b]) => s.replaceAll(a, b), text);
const rawWords = transcript.segments.flatMap(s => s.words);
const words = rawWords.map(w => ({ ...w, word: spoken(w.word) }));
const literalWords = rawWords.map(w => ({ ...w, word: normalizeTerms(w.word) }));
const displayCaptions = film.scenes.flatMap(s => s.captions.map(c => c.text));
const sheet = film.scenes.flatMap((s, index) => s.captions.map(c => ({ text: spoken(c.text), section: false, part: String(index), srcLine: 0 })));
const mergeAlignments = (literal, phonetic) => {
  const lines = literal.lines.map((a, i) => {
    const b = phonetic.lines[i];
    const useB = a.interpolated && !b.interpolated || a.interpolated === b.interpolated && b.confidence > a.confidence;
    return { ...(useB ? b : a), match_mode: useB ? 'spoken-form' : 'written-form' };
  });
  for (let i = 1; i < lines.length; i++) if (lines[i].at < lines[i - 1].at) throw new Error('Alignment modes disagree about caption order; inspect timestamps.');
  return { lines, flagged: lines.flatMap((l, i) => l.interpolated ? [i] : []) };
};
const aligned = mergeAlignments(
  alignLyrics(sheet.map((s, i) => ({ ...s, text: displayCaptions[i] })), literalWords, { minConfidence: 0.35 }),
  alignLyrics(sheet, words, { minConfidence: 0.35 }),
);
const sceneAligned = mergeAlignments(
  alignLyrics(film.scenes.map(s => ({ text: normalizeTerms(s.narration), section: false, srcLine: 0 })), literalWords, { minConfidence: 0.4 }),
  alignLyrics(film.scenes.map(s => ({ text: s.narration, section: false, srcLine: 0 })), words, { minConfidence: 0.4 }),
);
const preroll = 1;
const fps = 30;
const frame = t => Math.round(t * fps);
const boundaries = film.scenes.map((_, i) => i === 0 ? 0 : frame(preroll + sceneAligned.lines[i].at - 0.3) / fps);
const totalFrames = Math.ceil((preroll + asset.duration + 1.6) * fps);
boundaries.push(totalFrames / fps);
const audit = {
  format: 'devday.narration-alignment/1', audio_asset: asset.id,
  transcript: `.vos/analysis/${asset.id}/transcript.json`,
  engine: transcript.provenance, preroll, audio_duration: asset.duration,
  total_duration: totalFrames / fps,
  scene_flagged: sceneAligned.flagged, caption_flagged: aligned.flagged,
  scenes: film.scenes.map((s, i) => ({ id: s.id, at: boundaries[i], duration: boundaries[i + 1] - boundaries[i], speech_at: sceneAligned.lines[i].at, confidence: sceneAligned.lines[i].confidence })),
  captions: aligned.lines.map((l, i) => ({ scene: Number(l.part), text: displayCaptions[i], at: preroll + l.at, end: Math.min(boundaries[Number(l.part) + 1], preroll + Math.min(l.end ?? Infinity, aligned.lines[i + 1]?.at ?? asset.duration)), confidence: l.confidence, match_mode: l.match_mode, interpolated: l.interpolated ?? false })),
};
fs.writeFileSync(path.join(root, 'data/narration-alignment.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(JSON.stringify({ scenes: audit.scenes, captions: audit.captions.length, caption_flagged: audit.caption_flagged, scene_flagged: audit.scene_flagged, low_confidence: audit.captions.map((c, i) => ({ i, ...c })).filter(c => c.confidence < 0.6) }, null, 2));

if (process.argv.includes('--apply')) {
  if (audit.scene_flagged.length || audit.caption_flagged.length) throw new Error('Flagged alignment must be reviewed before applying.');
  const clips = [], slots = [], markers = [];
  for (let i = 0; i < film.scenes.length; i++) {
    const s = film.scenes[i], at = boundaries[i], duration = boundaries[i + 1] - at;
    if (duration <= 2) throw new Error(`Invalid scene duration: ${s.id}`);
    s.planned_start = at; s.planned_duration = duration;
    s.captions = audit.captions.filter(c => c.scene === i).map(c => {
      const start = Math.max(0, c.at - at);
      const end = Math.min(duration, c.end - at);
      if (end <= start || start >= duration) throw new Error(`Caption outside scene: ${s.id}`);
      return { text: c.text, at: Math.round(start * 1000) / 1000, dur: Math.round((end - start) * 1000) / 1000 };
    });
    clips.push({ id: s.id, src: 'graphics/scene.html', at: `${frame(at)}f`, dur: `${frame(duration)}f`, props: { film: { $data: 'data/film.json' }, index: i, start: at, duration, total: totalFrames / fps, preview: false } });
    if (s.layout === 'demo') slots.push({ id: 'dots-demo', asset: 'dots_official', at: `${frame(at + .8)}f`, in: 1, dur: Math.min(14, duration - .9), slot: `${s.id}/demo` });
    markers.push({ at: `${frame(at)}f`, label: s.chapter, kind: 'chapter' });
    if (s.layout !== 'demo') markers.push({ at: `${frame(at + 1.5)}f`, dur: duration - 1.5, label: `Reading hold: ${s.id}`, kind: 'expect-still' });
  }
  const closing = film.scenes.at(-1);
  closing.cards = closing.cards.map(c => typeof c === 'string' ? c.replace('ナレーション予定：', 'ナレーション：') : c);
  const timeline = { format: 'vos.timeline/1', name: 'devday-2026-internal', canvas: { width: 1920, height: 1080, fps, background: '#101d25' }, duration: `${totalFrames}f`, tracks: [
    { id: 'G1', kind: 'graphics', clips }, { id: 'S1', kind: 'video', clips: slots },
    { id: 'A1', kind: 'audio', clips: [{ id: 'narration', asset: 'narration', at: preroll, dur: asset.duration, gain_db: 0 }] },
  ], markers, master: { loudness: -16, true_peak: -1 } };
  fs.writeFileSync(filmPath, JSON.stringify(film, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
  const timecode = t => {
    const ms = Math.round(t * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  const srt = audit.captions.map((c, i) => `${i + 1}\n${timecode(c.at)} --> ${timecode(c.end)}\n${c.text}\n`).join('\n');
  fs.writeFileSync(path.join(root, 'data/captions.srt'), srt);
  console.log(JSON.stringify({ applied: true, frames: totalFrames, seconds: totalFrames / fps, captions: audit.captions.length }));
}
