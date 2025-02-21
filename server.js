const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Create temp directory
const tempDir = path.join(process.cwd(), 'tts_wav_output');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    console.log('Created temp output folder:', tempDir);
}

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

function runEspeak(args) {
    return new Promise((resolve, reject) => {
        console.log('Executing command:', 'espeak', args.join(' '));
        const espeak = spawn('espeak', args);
        
        let errorOutput = '';
        
        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('eSpeak stderr:', data.toString());
        });
        
        espeak.on('close', (code) => {
            console.log(`Process exited with code ${code}`);
            if (code !== 0) {
                return reject(new Error(`eSpeak failed with code ${code}: ${errorOutput}`));
            }
            resolve();
        });
        
        espeak.on('error', (error) => {
            console.error('eSpeak process error:', error);
            reject(error);
        });
    });
}

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        
        // Create a unique hash for the audio
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(tempDir, `audio_${hash}.wav`);
        
        // Generate WAV file
        const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
        await runEspeak(args);
        
        // Read the WAV file directly
        const wavData = fs.readFileSync(wavFile);
        const fileSize = wavData.length;
        console.log('WAV file size:', fileSize);
        
        // Get WAV duration (assuming 44.1kHz, 16-bit, mono)
        const headerSize = 44; // WAV header size
        const duration = (fileSize - headerSize) / (44100 * 2);
        
        // Encode WAV data as base64
        const base64Data = wavData.toString('base64');
        console.log('Base64 data length:', base64Data.length);
        
        const response = {
            audio_id: hash,
            audio_data: base64Data,
            duration: duration,
            file_size: fileSize,
            format: {
                type: 'wav',
                sampleRate: 44100,
                channels: 1,
                bitDepth: 16
            }
        };
        
        console.log('Sending response:', {
            ...response,
            audio_data: `[Base64 string length: ${response.audio_data.length}]`
        });
        
        // Clean up the WAV file
        fs.unlink(wavFile, (err) => {
            if (err) console.error(`Failed to delete ${wavFile}:`, err);
            else console.log('WAV file cleaned up');
        });
        
        // Send response
        res.json(response);
        
    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        tempDir: tempDir,
        tempDirExists: fs.existsSync(tempDir),
        platform: process.platform
    });
});

app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
});
