const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;
const AUDIO_FILE = path.join(__dirname, 'WhatsApp Audio 2026-06-02 at 15.32.32.mp4');
const CONVERTED_WAV = path.join(__dirname, 'audio_converted.wav');

// ─── Twang Analysis Engine ────────────────────────────────────────────────────

const SAMPLE_RATE = 44100;
const FFT_SIZE = 2048;
const HOP_SIZE = 512;

/**
 * Compute FFT magnitudes from a Float32Array of PCM samples.
 */
function computeFFT(samples) {
  const N = FFT_SIZE;
  const real = new Float64Array(N);
  const imag = new Float64Array(N);

  // Hann window
  for (let i = 0; i < N && i < samples.length; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    real[i] = samples[i] * w;
  }

  // In-place Cooley–Tukey FFT
  fftInPlace(real, imag, N);

  const mags = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mags;
}

function fftInPlace(re, im, N) {
  // Bit-reversal
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

/**
 * Bin index for a given frequency.
 */
function freqToBin(freq, sampleRate, fftSize) {
  return Math.round((freq / sampleRate) * fftSize);
}

/**
 * Sum energy in a frequency band [fLow, fHigh].
 */
function bandEnergy(mags, fLow, fHigh, sampleRate) {
  const N = mags.length * 2;
  const lo = freqToBin(fLow, sampleRate, N);
  const hi = freqToBin(fHigh, sampleRate, N);
  let energy = 0;
  for (let i = lo; i <= hi && i < mags.length; i++) {
    energy += mags[i] * mags[i];
  }
  return energy;
}

/**
 * Spectral centroid in a given frequency range.
 */
function spectralCentroid(mags, fLow, fHigh, sampleRate) {
  const N = mags.length * 2;
  const lo = freqToBin(fLow, sampleRate, N);
  const hi = freqToBin(fHigh, sampleRate, N);
  let weightedSum = 0;
  let totalMag = 0;
  for (let i = lo; i <= hi && i < mags.length; i++) {
    const freq = (i / N) * sampleRate;
    weightedSum += mags[i] * freq;
    totalMag += mags[i];
  }
  return totalMag > 0 ? weightedSum / totalMag : 0;
}

/**
 * Find the dominant peak frequency in a band.
 */
function peakFreqInBand(mags, fLow, fHigh, sampleRate) {
  const N = mags.length * 2;
  const lo = freqToBin(fLow, sampleRate, N);
  const hi = freqToBin(fHigh, sampleRate, N);
  let maxMag = 0, maxBin = lo;
  for (let i = lo; i <= hi && i < mags.length; i++) {
    if (mags[i] > maxMag) { maxMag = mags[i]; maxBin = i; }
  }
  return (maxBin / N) * sampleRate;
}

/**
 * Detect voice activity: RMS above threshold.
 */
function isVoiceActive(samples, threshold = 0.01) {
  let rms = 0;
  for (let s of samples) rms += s * s;
  rms = Math.sqrt(rms / samples.length);
  return rms > threshold;
}

/**
 * Main twang scoring function.
 * Returns a score 0–100 and breakdown components.
 */
function analyzeTwang(samples, sampleRate = SAMPLE_RATE) {
  const mags = computeFFT(samples);

  // Total energy
  const totalEnergy = bandEnergy(mags, 80, 8000, sampleRate);
  if (totalEnergy < 1e-10) return null;

  // ── Component 1: Epilaryngeal / twang band (2000–4000 Hz)
  const twangBandEnergy = bandEnergy(mags, 2000, 4000, sampleRate);
  const twangRatio = twangBandEnergy / totalEnergy;
  const twangScore = Math.min(100, twangRatio * 600); // normalized

  // ── Component 2: F1 elevation (500–1200 Hz peak → higher = more twang)
  const f1Freq = peakFreqInBand(mags, 400, 1200, sampleRate);
  // Typical neutral F1 ~500Hz, twangy F1 ~900–1200Hz
  const f1Score = Math.min(100, Math.max(0, ((f1Freq - 400) / 800) * 100));

  // ── Component 3: Spectral concentration 1000–2500 Hz
  const midEnergy = bandEnergy(mags, 1000, 2500, sampleRate);
  const midRatio = midEnergy / totalEnergy;
  const midScore = Math.min(100, midRatio * 350);

  // ── Component 4: Brilliance ratio (3000–6000 Hz vs low 80–1000 Hz)
  const brillianceEnergy = bandEnergy(mags, 3000, 6000, sampleRate);
  const lowEnergy = bandEnergy(mags, 80, 1000, sampleRate);
  const brillianceRatio = lowEnergy > 0 ? brillianceEnergy / lowEnergy : 0;
  const brillianceScore = Math.min(100, brillianceRatio * 300);

  // ── Weighted composite
  const composite = (
    twangScore * 0.40 +
    f1Score * 0.25 +
    midScore * 0.20 +
    brillianceScore * 0.15
  );

  // Spectral breakdown for visualization
  const bands = {
    sub:    bandEnergy(mags, 80, 300, sampleRate) / totalEnergy,
    low:    bandEnergy(mags, 300, 800, sampleRate) / totalEnergy,
    mid:    bandEnergy(mags, 800, 2000, sampleRate) / totalEnergy,
    high:   bandEnergy(mags, 2000, 4000, sampleRate) / totalEnergy,
    air:    bandEnergy(mags, 4000, 8000, sampleRate) / totalEnergy,
  };

  return {
    score: Math.round(composite * 10) / 10,
    components: {
      twangBand: Math.round(twangScore * 10) / 10,
      f1Elevation: Math.round(f1Score * 10) / 10,
      midConcentration: Math.round(midScore * 10) / 10,
      brilliance: Math.round(brillianceScore * 10) / 10,
    },
    f1Freq: Math.round(f1Freq),
    spectralBands: bands,
    mags: Array.from(mags).slice(0, 512), // first 512 bins for viz
  };
}

// ─── Audio File Processing ────────────────────────────────────────────────────

async function convertAudioFile() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(CONVERTED_WAV)) {
      resolve(CONVERTED_WAV);
      return;
    }
    console.log('🎵 Converting audio file...');
    ffmpeg(AUDIO_FILE)
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => { console.log('✅ Conversion done'); resolve(CONVERTED_WAV); })
      .on('error', reject)
      .save(CONVERTED_WAV);
  });
}

/**
 * Parse WAV file and return Float32Array of samples.
 */
function parseWAV(filePath) {
  const buf = fs.readFileSync(filePath);
  // WAV header: 44 bytes for standard PCM
  const numChannels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);

  let dataOffset = 44;
  // Find 'data' chunk
  for (let i = 12; i < buf.length - 4; i++) {
    if (buf[i] === 0x64 && buf[i+1] === 0x61 && buf[i+2] === 0x74 && buf[i+3] === 0x61) {
      dataOffset = i + 8;
      break;
    }
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((buf.length - dataOffset) / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * bytesPerSample * numChannels;
    if (bitsPerSample === 16) {
      samples[i] = buf.readInt16LE(offset) / 32768;
    } else if (bitsPerSample === 32) {
      samples[i] = buf.readFloatLE(offset);
    }
  }

  return { samples, sampleRate, numSamples };
}

/**
 * Detect voice onset (when person starts speaking/singing).
 * Returns the sample index.
 */
function detectVoiceOnset(samples, sampleRate, windowMs = 50, thresholdMultiplier = 3) {
  const windowSize = Math.round(sampleRate * windowMs / 1000);
  
  // Compute RMS for each window
  const rmsValues = [];
  for (let i = 0; i + windowSize < samples.length; i += windowSize) {
    let rms = 0;
    for (let j = 0; j < windowSize; j++) rms += samples[i + j] ** 2;
    rmsValues.push(Math.sqrt(rms / windowSize));
  }

  // Baseline noise: first 500ms
  const baselineWindows = Math.ceil(500 / windowMs);
  const baseline = rmsValues.slice(0, baselineWindows).reduce((a, b) => a + b, 0) / baselineWindows;
  const threshold = baseline * thresholdMultiplier + 0.005;

  // Find first sustained activity (3 consecutive windows above threshold)
  for (let i = baselineWindows; i < rmsValues.length - 2; i++) {
    if (rmsValues[i] > threshold && rmsValues[i+1] > threshold && rmsValues[i+2] > threshold) {
      return i * windowSize;
    }
  }
  return 0;
}

/**
 * Analyze full audio file frame by frame.
 * Returns array of { time, score, components } for each voiced frame.
 */
async function analyzeFile() {
  await convertAudioFile();
  const { samples, sampleRate, numSamples } = parseWAV(CONVERTED_WAV);
  
  const onsetSample = detectVoiceOnset(samples, sampleRate);
  const onsetTime = onsetSample / sampleRate;
  console.log(`🎤 Voice onset detected at ${onsetTime.toFixed(2)}s`);

  const results = [];
  const effectiveSamples = samples.slice(onsetSample);
  
  for (let i = 0; i + FFT_SIZE < effectiveSamples.length; i += HOP_SIZE) {
    const frame = effectiveSamples.slice(i, i + FFT_SIZE);
    
    // Only analyze voiced frames
    if (!isVoiceActive(frame, 0.008)) continue;
    
    const analysis = analyzeTwang(frame, sampleRate);
    if (analysis) {
      results.push({
        time: (onsetSample + i) / sampleRate,
        ...analysis,
        mags: undefined, // exclude from file results (too large)
      });
    }
  }

  // Overall stats
  if (results.length === 0) return { error: 'No voiced frames detected', results: [] };

  const scores = results.map(r => r.score);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);

  return {
    onsetTime,
    totalFrames: results.length,
    avgScore: Math.round(avgScore * 10) / 10,
    maxScore: Math.round(maxScore * 10) / 10,
    minScore: Math.round(minScore * 10) / 10,
    duration: results[results.length - 1].time - onsetTime,
    results: results.map(r => ({
      time: Math.round(r.time * 100) / 100,
      score: r.score,
      components: r.components,
      f1Freq: r.f1Freq,
    })),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/analyze-file', async (req, res) => {
  try {
    console.log('📊 Starting file analysis...');
    const result = await analyzeFile();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── WebSocket: real-time mic analysis ────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  let buffer = [];

  ws.on('message', (data) => {
    try {
      // data = Float32Array PCM samples sent from browser
      const samples = new Float32Array(data.buffer || data);
      buffer.push(...samples);

      // Process in FFT_SIZE chunks
      while (buffer.length >= FFT_SIZE) {
        const frame = new Float32Array(buffer.splice(0, FFT_SIZE));
        
        if (!isVoiceActive(frame, 0.008)) {
          ws.send(JSON.stringify({ type: 'silence' }));
          continue;
        }

        const analysis = analyzeTwang(frame, SAMPLE_RATE);
        if (analysis) {
          ws.send(JSON.stringify({
            type: 'analysis',
            score: analysis.score,
            components: analysis.components,
            f1Freq: analysis.f1Freq,
            spectralBands: analysis.spectralBands,
            mags: analysis.mags,
          }));
        }
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => console.log('🔌 Client disconnected'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🎸 Twang Analyzer running at http://localhost:${PORT}\n`);
  // Pre-analyze file on startup
  analyzeFile().then(r => {
    console.log(`📊 File pre-analysis: avg twang score = ${r.avgScore}`);
  }).catch(e => console.error('Pre-analysis error:', e));
});
