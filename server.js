import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Configuration
const config = {
    port: process.env.PORT || 8080,
    robloxApiKey: process.env.ROBLOX_API_KEY,
    robloxCreatorId: process.env.ROBLOX_CREATOR_ID,
    robloxSecurityCookie: process.env.ROBLOX_SECURITY_COOKIE,
    maxAudioSize: 20 * 1024 * 1024, // 20MB
    cleanupInterval: 3600000, // 1 hour
    maxTextLength: 1000,
    audioDir: path.join(__dirname, 'audio')
};

// Initialize Express middleware
app.use(express.json());

// Create audio directory
if (!fs.existsSync(config.audioDir)) {
    fs.mkdirSync(config.audioDir, { recursive: true });
    console.log('Created audio directory:', config.audioDir);
}

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Get audio duration using FFmpeg
async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn('ffmpeg', [
            '-i', filePath,
            '-f', 'null',
            '-'
        ]);

        let output = '';
        ffprobe.stderr.on('data', (data) => {
            output += data.toString();
        });

        ffprobe.on('close', () => {
            const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
            if (durationMatch) {
                const [, hours, minutes, seconds, centiseconds] = durationMatch;
                const duration = parseInt(hours) * 3600 + 
                               parseInt(minutes) * 60 + 
                               parseInt(seconds) + 
                               parseInt(centiseconds) / 100;
                resolve(duration);
            } else {
                resolve(0);
            }
        });

        ffprobe.on('error', (err) => {
            console.error('FFmpeg error:', err);
            resolve(0);
        });
    });
}

// Enhanced espeak function
async function runEspeak(text, voice, speed, outputPath) {
    return new Promise((resolve, reject) => {
        console.log('Running eSpeak:', { text, voice, speed, outputPath });
        const process = spawn('espeak', [
            '-v', voice,
            '-s', speed.toString(),
            text,
            '-w', outputPath
        ]);

        let errorOutput = '';
        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.log('eSpeak stderr:', data.toString());
        });

        process.stdout.on('data', (data) => {
            console.log('eSpeak stdout:', data.toString());
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('eSpeak process timed out'));
        }, 30000);

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`eSpeak failed (${code}): ${errorOutput}`));
            }
        });
    });
}

// Enhanced audio conversion using FFmpeg
async function convertToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        console.log('Converting to MP3:', { input: inputPath, output: outputPath });
        const process = spawn('ffmpeg', [
            '-i', inputPath,
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-ar', '44100',
            '-y',
            outputPath
        ]);

        let errorOutput = '';
        process.stderr.on('data', (data) => {
            errorOutput += data.toString();
            console.log('FFmpeg stderr:', data.toString());
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('FFmpeg process timed out'));
        }, 30000);

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve();
            } else {
                reject(new Error(`FFmpeg failed (${code}): ${errorOutput}`));
            }
        });
    });
}

// Improved Roblox upload function with proper file handling
async function uploadAudioToRoblox(audioPath) {
    if (!config.robloxApiKey || !config.robloxCreatorId || !config.robloxSecurityCookie) {
        throw new Error('Roblox API credentials not configured');
    }

    const stats = fs.statSync(audioPath);
    if (stats.size > config.maxAudioSize) {
        throw new Error(`File exceeds maximum size (${config.maxAudioSize} bytes)`);
    }

    const form = new FormData();
    const fileStream = fs.createReadStream(audioPath);
    
    form.append('file', fileStream, {
        filename: path.basename(audioPath),
        contentType: 'audio/mpeg'
    });
    
    form.append('name', path.basename(audioPath, '.mp3'));
    form.append('creatorTargetId', config.robloxCreatorId);
    form.append('creatorType', 'User');
    form.append('description', 'TTS Audio');
    form.append('paymentModalType', 'None');

    console.log('Uploading to Roblox:', {
        filename: path.basename(audioPath),
        size: stats.size,
        creatorId: config.robloxCreatorId
    });

    const response = await fetch('https://publish.roblox.com/v1/audio', {
        method: 'POST',
        headers: {
            'x-api-key': config.robloxApiKey,
            'Cookie': `.ROBLOSECURITY=${config.robloxSecurityCookie}`,
            ...form.getHeaders()
        },
        body: form
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Upload failed: ${response.status} ${JSON.stringify(error)}`);
    }

    const data = await response.json();
    return data.audioAssetId || data.assetId;
}

// Main TTS endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;

        if (!text?.trim()) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        if (text.length > config.maxTextLength) {
            return res.status(400).json({ error: `Text exceeds maximum length of ${config.maxTextLength}` });
        }
        if (speed < 80 || speed > 500) {
            return res.status(400).json({ error: 'Speed must be between 80 and 500' });
        }

        const hash = crypto.createHash('md5').update(`${text}${voice}${speed}`).digest('hex');
        const wavFile = path.join(config.audioDir, `${hash}.wav`);
        const mp3File = path.join(config.audioDir, `${hash}.mp3`);

        console.log('Processing TTS request:', { text, voice, speed, hash });

        if (fs.existsSync(mp3File)) {
            console.log('Cache hit:', hash);
            const duration = await getAudioDuration(mp3File);
            const stats = fs.statSync(mp3File);
            
            return res.json({
                audio_id: hash,
                duration,
                file_size: stats.size
            });
        }

        await runEspeak(text, voice, speed, wavFile);
        await convertToMp3(wavFile, mp3File);
        
        if (fs.existsSync(wavFile)) {
            fs.unlinkSync(wavFile);
            console.log('Cleaned up WAV file:', wavFile);
        }
        
        const duration = await getAudioDuration(mp3File);
        const stats = fs.statSync(mp3File);

        res.json({
            audio_id: hash,
            duration,
            file_size: stats.size
        });

    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'TTS processing failed',
            details: error.message
        });
    }
});

// Enhanced Roblox upload endpoint
app.post('/api/upload-to-roblox', async (req, res) => {
    try {
        const { audioId } = req.body;
        if (!audioId) {
            return res.status(400).json({ error: 'Missing audioId' });
        }

        const mp3File = path.join(config.audioDir, `${audioId}.mp3`);
        if (!fs.existsSync(mp3File)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        console.log('Processing Roblox upload:', audioId);
        const robloxAssetId = await uploadAudioToRoblox(mp3File);
        
        res.json({
            success: true,
            robloxAssetId
        });

    } catch (error) {
        console.error('Roblox upload error:', error);
        res.status(500).json({
            error: 'Roblox upload failed',
            details: error.message
        });
    }
});

// Start server
app.listen(config.port, () => {
    console.log(`
TTS Server Started
- Port: ${config.port}
- Audio directory: ${config.audioDir}
- Roblox API: ${config.robloxApiKey ? 'Configured' : 'Not configured'}
- Roblox Creator ID: ${config.robloxCreatorId ? 'Configured' : 'Not configured'}
- Roblox Security Cookie: ${config.robloxSecurityCookie ? 'Configured' : 'Not configured'}
    `);
});
