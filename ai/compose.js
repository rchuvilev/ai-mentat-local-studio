'use strict';
//
// FFmpeg composition: Ken Burns motion, frame sequences, and the final mux.
//
// Design note (Apr 29): "why every scene generates 10+ frame-images but in fact
// it is single one with camera movements applied for scene" — the original
// generated a pile of near-identical stills and then only panned across one of
// them, paying full diffusion cost for frames it discarded. Ken Burns here is
// explicitly one still plus an ffmpeg zoompan, and any mode that claims real
// per-frame motion actually produces distinct frames (see motion.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

function ffmpegBin() {
  // Prefer whatever is on PATH; fall back to the usual Homebrew locations that
  // a GUI app launched from Finder will not have inherited.
  const candidates = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) {
    try { execSync(`"${c}" -version`, { timeout: 4000, stdio: 'pipe' }); return c; } catch {}
  }
  return null;
}

function assertFfmpeg() {
  const bin = ffmpegBin();
  if (!bin) {
    const hint = { darwin: 'brew install ffmpeg', win32: 'winget install Gyan.FFmpeg', linux: 'sudo apt install ffmpeg' }[process.platform];
    throw new Error(`FFmpeg not found. Install it: ${hint}`);
  }
  return bin;
}

function runFfmpeg(args, { logger, signal } = {}) {
  const bin = assertFfmpeg();
  return new Promise((resolve, reject) => {
    logger?.info(`ffmpeg ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const proc = spawn(bin, ['-hide_banner', '-loglevel', 'warning', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onAbort = () => { try { proc.kill('SIGKILL'); } catch {} };
    if (signal) {
      if (signal.aborted) { onAbort(); return reject(new Error('cancelled')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cap = (b) => {
      const t = b.toString();
      tail = (tail + t).slice(-3000);
      for (const l of t.split(/[\r\n]+/)) if (l.trim()) logger?.info(`ffmpeg| ${l.trim()}`);
    };
    proc.stdout.on('data', cap);
    proc.stderr.on('data', cap);
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (signal?.aborted) return reject(new Error('cancelled'));
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${tail.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

const DIMENSIONS = {
  landscape: { w: 832, h: 480 },
  portrait:  { w: 480, h: 832 },
  square:    { w: 640, h: 640 },
};

function dimensionsFor(orientation) { return DIMENSIONS[orientation] || DIMENSIONS.landscape; }

/**
 * Ken Burns: one still, panned and zoomed for `seconds`.
 *
 * This is the fallback path — cheap, always available, and honest about being a
 * camera move over a static image rather than generated motion.
 */
async function kenBurns({ image, outPath, seconds, fps, orientation, zoom = 1.18, logger, signal }) {
  const { w, h } = dimensionsFor(orientation);
  const frames = Math.max(1, Math.round(seconds * fps));
  // zoompan works on an upscaled source to avoid visible stepping.
  const filter = [
    `scale=${w * 2}:${h * 2}:flags=lanczos`,
    `zoompan=z='min(zoom+${((zoom - 1) / frames).toFixed(6)},${zoom})':d=${frames}:s=${w}x${h}:fps=${fps}`
      + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    'format=yuv420p',
  ].join(',');

  await runFfmpeg([
    '-loop', '1', '-i', image,
    '-t', String(seconds),
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-r', String(fps),
    outPath,
  ], { logger, signal });
  return outPath;
}

/** Encode a directory of numbered frames (real generated motion) into a clip. */
async function framesToVideo({ pattern, outPath, fps, logger, signal }) {
  await runFfmpeg([
    '-framerate', String(fps),
    '-i', pattern,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p',
    outPath,
  ], { logger, signal });
  return outPath;
}

/** Concatenate scene clips in order. */
async function concatClips({ clips, outPath, logger, signal }) {
  if (clips.length === 1) { fs.copyFileSync(clips[0], outPath); return outPath; }
  const listFile = path.join(os.tmpdir(), `mentat-concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], { logger, signal });
  } finally {
    try { fs.unlinkSync(listFile); } catch {}
  }
  return outPath;
}

/**
 * Mux narration and/or music onto a video.
 *
 * Music is ducked under narration when both are present so the voice stays
 * intelligible, and the result is cut to the video length.
 */
async function mux({ video, voice, music, outPath, musicGainDb = -12, logger, signal }) {
  const inputs = ['-i', video];
  const audio = [];
  if (voice && fs.existsSync(voice)) { inputs.push('-i', voice); audio.push('voice'); }
  if (music && fs.existsSync(music)) { inputs.push('-i', music); audio.push('music'); }

  if (!audio.length) { fs.copyFileSync(video, outPath); return outPath; }

  let filter;
  if (audio.length === 2) {
    filter = `[2:a]volume=${musicGainDb}dB[m];[1:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]`;
  } else if (audio[0] === 'music') {
    filter = `[1:a]volume=${musicGainDb}dB[a]`;
  } else {
    filter = `[1:a]anull[a]`;
  }

  await runFfmpeg([
    ...inputs,
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    outPath,
  ], { logger, signal });
  return outPath;
}

/** Still image -> poster-framed mp4, used when only an image was generated. */
async function stillToVideo({ image, outPath, seconds, fps, orientation, logger, signal }) {
  const { w, h } = dimensionsFor(orientation);
  await runFfmpeg([
    '-loop', '1', '-i', image, '-t', String(seconds),
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-r', String(fps),
    outPath,
  ], { logger, signal });
  return outPath;
}

function probeDuration(file) {
  try {
    const bin = ffmpegBin();
    if (!bin) return null;
    const probe = bin.replace(/ffmpeg$/, 'ffprobe');
    const out = execSync(`"${probe}" -v error -show_entries format=duration -of csv=p=0 "${file}"`, {
      timeout: 8000, stdio: 'pipe',
    }).toString().trim();
    const n = parseFloat(out);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

module.exports = {
  ffmpegBin, assertFfmpeg, runFfmpeg,
  kenBurns, framesToVideo, concatClips, mux, stillToVideo,
  dimensionsFor, probeDuration, DIMENSIONS,
};
