const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

const tempDir = path.join(process.cwd(), 'tts_output');

// Create output directory
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

app.use(bodyParser.json());

// CORS headers for Roblox
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Convert WAV to raw PCM data
function convertToRawPCM(wavFile) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', wavFile,
            '-f', 's16le',  // 16-bit signed little-endian
            '-acodec', 'pcm_s16le',
            '-ar', '44100', // Sample rate
            '-ac', '1',     // Mono
            '-']);         // Output to stdout

        const chunks = [];
        
        ffmpeg.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        ffmpeg.stderr.on('data', (data) => {
            console.error(`FFmpeg stderr: ${data}`);
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                const buffer = Buffer.concat(chunks);
                resolve(buffer);
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', reject);
    });
}

app.post('/api/tts', async (req, res) => {
    try {
        if (!req.body || !req.body.text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }

        const { text, voice = 'en', speed = 175 } = req.body;
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(tempDir, `audio_${hash}.wav`);

        const args = [
            '-v', voice,
            '-s', speed.toString(),
            text,
            '-w', wavFile
        ];

        const espeak = spawn('espeak', args);

        let errorOutput = '';
        espeak.stderr.on('data', (data) => {
            errorOutput += data;
        });

        espeak.on('close', async (code) => {
            if (code !== 0) {
                return res.status(500).json({
                    error: 'eSpeak failed',
                    details: errorOutput
                });
            }

            try {
                // Convert to raw PCM data
                const audioData = await convertToRawPCM(wavFile);
                
                // Calculate duration based on PCM data
                const duration = audioData.length / (44100 * 2); // 2 bytes per sample
                
                // Clean up WAV file
                fs.unlinkSync(wavFile);

                // Send response with binary audio data
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
                console.error('Conversion error:', error);
                res.status(500).json({
                    error: 'Audio conversion failed',
                    details: error.message
                });
            }
        });

    } catch (error) {
        console.error("Server error:", error);
        return res.status(500).json({ 
            error: "Internal server error", 
            details: error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`eSpeak TTS server listening on port ${port}`);
});
