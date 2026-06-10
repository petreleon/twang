const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

// ─── Cross-Origin Isolation (required for SharedArrayBuffer / ffmpeg.wasm) ───
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

// ─── Serve Static Files ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Serve the sample audio file to the browser
app.get('/audio/sample.mp4', (req, res) => {
  res.sendFile(path.join(__dirname, 'sample.mp4'));
});

// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎸 static server running at http://localhost:${PORT}\n`);
});
