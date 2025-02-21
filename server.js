const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Use express.json() for parsing JSON bodies
app.use(express.json());

// Create a temporary directory for audio output if it doesn't exist
const tempDir = path.join(process.cwd(), 'tts_output');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// CORS headers for Roblox
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Wrap the espeak process in a promise
function runEspeak(args) {
    return new Promise((resolve, reject) => {
        const espeak = spawn('espeak', args);
        let errorOutput = '';

        espeak.stderr.on('data', (data) => {
            errorOutput += data;
        });

        espeak.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`eSpeak failed with code ${code}: ${errorOutput}`));
            }
            resolve();
        });

        espeak.on('error', reject);
    });
}

// Convert WAV file to raw PCM data using FFmpeg
function convertToRawPCM(wavFile) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', wavFile,
            '-f', 's16le',  // 16-bit signed little-endian
            '-acodec', 'pcm_s16le',
            '-ar', '44100', // Sample rate
            '-ac', '1',     // Mono
            '-'             // Output to stdout
        ]);

        const chunks = [];
        ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
        ffmpeg.stderr.on('data', (data) => console.error(`FFmpeg stderr: ${data}`));

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(chunks));
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }

        // Create a hash for the filename based on the text, voice, and speed
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(tempDir, `audio_${hash}.wav`);
        const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];

        // Run espeak to generate the WAV file
        await runEspeak(args);

        // Convert the generated WAV file to raw PCM data
        const audioData = await convertToRawPCM(wavFile);
        const duration = audioData.length / (44100 * 2); // 2 bytes per sample

        // Clean up the WAV file asynchronously
        fs.unlink(wavFile, (err) => {
            if (err) {
                console.error(`Failed to delete ${wavFile}: ${err}`);
            }
        });

        // Send the response with the base64-encoded audio data
        res.json({
            audio_data: audioData.toString('base64'),
            duration: duration,
            format: {
                sampleRate: 44100,
                channels: 1,
                bitDepth: 16
            }
        });
    } catch (error) {
        console.error('Error processing TTS request:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

app.listen(port, () => {
    console.log(`eSpeak TTS server listening on port ${port}`);
});
