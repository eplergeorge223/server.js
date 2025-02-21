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
try {
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    console.log(`Created temp output folder: ${tempDir}`);
} catch (err) {
    console.error(`Failed to create output directory: ${err.message}`);
    process.exit(1);
}

app.use(bodyParser.json());

// Add CORS headers that Roblox requires
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

function convertToMp3(wavFile, mp3File) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', wavFile,
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-ar', '44100',
            mp3File
        ]);

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
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

        // Generate a deterministic hash from the text, voice, and speed
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const audio_id = hash; // use the hash as the audio identifier
        const wavFile = path.join(tempDir, `audio_${audio_id}.wav`);
        const mp3File = path.join(tempDir, `audio_${audio_id}.mp3`);

        // If the MP3 already exists, return it immediately
        if (fs.existsSync(mp3File)) {
            console.log(`Audio for "${text}" already exists. Returning cached version.`);
            const stats = fs.statSync(mp3File);
            return res.json({
                audio_id: audio_id,
                // Using file size and known encoding parameters to roughly estimate duration
                duration: (stats.size / (44100 * (128 / 8))) || 1,
                file_size: stats.size
            });
        }

        // Otherwise, generate new audio
        // Clean up any existing temporary files (if any)
        [wavFile].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });

        const args = [
            '-v', voice,
            '-s', speed.toString(),
            text,
            '-w', wavFile
        ];

        console.log('Executing command: espeak', args.join(' '));

        const espeak = spawn('espeak', args);

        let errorOutput = '';

        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.error(`stderr: ${data}`);
        });

        espeak.on('error', (error) => {
            console.error('Error generating speech:', error);
            return res.status(500).json({
                error: 'Failed to generate speech',
                details: error.message
            });
        });

        espeak.on('close', async (code) => {
            if (code !== 0) {
                return res.status(500).json({
                    error: 'eSpeak failed',
                    details: errorOutput
                });
            }

            try {
                // Convert WAV to MP3
                await convertToMp3(wavFile, mp3File);

                // Get file stats for duration calculation
                const stats = fs.statSync(mp3File);
                
                // Clean up WAV file now that MP3 is ready
                fs.unlinkSync(wavFile);

                res.json({
                    audio_id: audio_id,
                    duration: (stats.size / (44100 * (128 / 8))) || 1,
                    file_size: stats.size
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

app.get('/audio/:id', (req, res) => {
    const mp3File = path.join(tempDir, `audio_${req.params.id}.mp3`);
    if (fs.existsSync(mp3File)) {
        res.header('Content-Type', 'audio/mpeg');
        res.header('Content-Disposition', 'attachment');
        res.sendFile(mp3File);
    } else {
        res.status(404).json({ error: "Audio file not found" });
    }
});

app.listen(port, () => {
    console.log(`eSpeak TTS server listening on port ${port}`);
});
