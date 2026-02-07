#!/usr/bin/env node
/**
 * Development server that bridges browser to Python Whisper service
 * Allows testing real transcription in browser without Electron
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const PORT = 3001;

// Simple HTTP server
const server = http.createServer(async (req, res) => {
  // Enable CORS for browser access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/transcribe' && req.method === 'POST') {
    console.log('📝 Received transcription request...');

    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', async () => {
      try {
        // Get audio data from request
        const audioBuffer = Buffer.concat(body);
        console.log(`📊 Audio buffer size: ${audioBuffer.length} bytes`);

        // Save to temp file
        const tempFile = path.join(os.tmpdir(), `audio-${Date.now()}.webm`);
        fs.writeFileSync(tempFile, audioBuffer);
        console.log(`💾 Saved to: ${tempFile}`);

        // Call Python whisper service
        const result = await transcribeAudio(tempFile);

        // Clean up
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          console.warn('Warning: Could not delete temp file:', e.message);
        }

        // Send result
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));

      } catch (error) {
        console.error('❌ Error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

/**
 * Transcribe audio using Python whisper service
 */
function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    console.log('🎤 Starting Python Whisper process...');

    const pythonProcess = spawn('python3', [
      path.join(__dirname, 'python', 'whisper_service.py')
    ]);

    let output = '';
    let errorOutput = '';

    pythonProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.log('[Python]', data.toString().trim());
    });

    pythonProcess.on('close', (code) => {
      try {
        // Parse JSON output from Python
        const lines = output.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);

        console.log('✅ Transcription complete:', result.text || result.error);
        resolve({
          success: !result.error,
          text: result.text || '',
          error: result.error,
          engine: 'python-whisper',
          processingTime: result.duration || 0
        });
      } catch (e) {
        console.error('❌ Failed to parse Python output:', e);
        console.error('Raw output:', output);
        console.error('Error output:', errorOutput);
        reject(new Error('Failed to parse transcription result'));
      }
    });

    // Send JSON request to Python service via stdin
    const request = JSON.stringify({
      action: 'transcribe_file',
      audio_file: audioPath,
      model: 'tiny'
    }) + '\n';

    pythonProcess.stdin.write(request);
    pythonProcess.stdin.end();
  });
}

server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 MVP-Echo Development Server');
  console.log('='.repeat(60));
  console.log(`\n✅ Server running on http://localhost:${PORT}`);
  console.log('✅ Faster-Whisper ready (CPU, int8, tiny model)');
  console.log('\n📝 Endpoint: POST http://localhost:${PORT}/transcribe');
  console.log('   Send audio as binary body (WebM format)\n');
  console.log('🎯 Now you can test real transcription from the browser!');
  console.log('   Just update the browser mock to use this endpoint.\n');
});
