const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const app = express();

// Configuration
const port = process.env.PORT || 8080;
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_CREATOR_ID = process.env.ROBLOX_CREATOR_ID;
const MAX_AUDIO_SIZE = 20 * 1024 * 1024; // 20MB limit
const CLEANUP_INTERVAL = 3600000; // 1 hour in milliseconds

// Initialize Express middleware
app.use(express.json());

// Create audio directory for storage
const audioDir = path.join(process.cwd(), 'audio');
if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    console.log('Created audio storage folder:', audioDir);
}

// Set CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Improved espeak function
function runEspeak(args) {
    return new Promise((resolve, reject) => {
        console.log('Executing command: espeak', args.join(' '));
        const espeak = spawn('espeak', args);
        let errorOutput = '';
        
        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('eSpeak stderr:', data.toString());
        });

        espeak.stdout.on('data', (data) => {
            console.log('eSpeak stdout:', data.toString());
        });

        espeak.on('close', (code) => {
            console.log(`espeak exited with code ${code}`);
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

// Improved audio conversion function
function convertToMp3(wavFile, mp3File) {
    return new Promise((resolve, reject) => {
        console.log('Converting WAV to MP3:', wavFile, '->', mp3File);
        
        const ffmpeg = spawn('ffmpeg', [
            '-i', wavFile,
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-ar', '44100',
            '-y',
            mp3File
        ]);

        let errorOutput = '';
        let outputLog = '';

        ffmpeg.stderr.on('data', (data) => {
            const message = data.toString();
            errorOutput += message;
            console.log('FFmpeg stderr:', message);
        });

        ffmpeg.stdout.on('data', (data) => {
            outputLog += data.toString();
            console.log('FFmpeg stdout:', data.toString());
        });

        ffmpeg.on('close', (code) => {
            console.log('FFmpeg conversion complete with code:', code);
            if (code === 0 && fs.existsSync(mp3File) && fs.statSync(mp3File).size > 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg conversion failed (code ${code}): ${errorOutput}`));
            }
        });

        ffmpeg.on('error', (error) => {
            console.error('FFmpeg process error:', error);
            reject(error);
        });
    });
}

// Fixed Roblox upload function
async function uploadToRoblox(audioPath) {
    if (!ROBLOX_API_KEY) {
        throw new Error('ROBLOX_API_KEY not configured');
    }
    if (!ROBLOX_CREATOR_ID) {
        throw new Error('ROBLOX_CREATOR_ID not configured');
    }

    // Verify file exists and is readable
    if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
    }

    const fileStats = fs.statSync(audioPath);
    if (fileStats.size > MAX_AUDIO_SIZE) {
        throw new Error(`File size ${fileStats.size} exceeds maximum allowed size of ${MAX_AUDIO_SIZE}`);
    }

    const form = new FormData();
    
    // Use fileContent as required by Roblox API
    form.append('fileContent', fs.createReadStream(audioPath));
    form.append('creatorId', ROBLOX_CREATOR_ID);
    form.append('assetType', 'Audio');
    form.append('displayName', path.basename(audioPath, '.mp3'));
    
    console.log('Uploading to Roblox:', {
        fileName: path.basename(audioPath),
        fileSize: fileStats.size,
        creatorId: ROBLOX_CREATOR_ID
    });

    try {
        const response = await fetch('https://apis.roblox.com/assets/v1/assets', {
            method: 'POST',
            headers: {
                'x-api-key': ROBLOX_API_KEY,
                ...form.getHeaders()
            },
            body: form
        });

        const responseText = await response.text();
        console.log('Roblox API Response:', {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers.raw(),
            body: responseText
        });

        if (!response.ok) {
            let errorDetails;
            try {
                errorDetails = JSON.parse(responseText);
            } catch (e) {
                errorDetails = responseText;
            }
            throw new Error(`Roblox upload failed: ${response.statusText}\nDetails: ${JSON.stringify(errorDetails)}`);
        }

        const data = JSON.parse(responseText);
        console.log('Roblox upload successful:', data);
        return data.id;
    } catch (error) {
        console.error('Upload error details:', error);
        throw error;
    }
}

// Serve audio files statically
app.use('/audio', express.static(audioDir));

// Main TTS endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        if (text.length > 1000) {
            return res.status(400).json({ error: 'Text exceeds maximum length of 1000 characters' });
        }
        
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(audioDir, `${hash}.wav`);
        const mp3File = path.join(audioDir, `${hash}.mp3`);
        
        console.log('Processing TTS request:', {
            text,
            voice,
            speed,
            hash
        });

        if (fs.existsSync(mp3File)) {
            console.log(`Audio cache hit for "${text}"`);
            const stats = fs.statSync(mp3File);
            const duration = (stats.size / (44100 * (128/8))) || 1;
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            return res.json({
                audio_id: hash,
                duration: duration,
                file_size: stats.size,
                url: `${baseUrl}/audio/${hash}.mp3`
            });
        }
        
        console.log('Generating new audio file');
        const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
        await runEspeak(args);
        await convertToMp3(wavFile, mp3File);
        
        if (fs.existsSync(wavFile)) {
            fs.unlinkSync(wavFile);
            console.log('Cleaned up WAV file:', wavFile);
        }
        
        const stats = fs.statSync(mp3File);
        const duration = (stats.size / (44100 * (128/8))) || 1;
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        
        const responseObj = {
            audio_id: hash,
            duration: duration,
            file_size: stats.size,
            url: `${baseUrl}/audio/${hash}.mp3`
        };
        
        console.log('Sending response:', responseObj);
        res.json(responseObj);
        
    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Roblox upload endpoint
app.post('/api/upload-to-roblox', async (req, res) => {
    try {
        const { audioId } = req.body;
        if (!audioId) {
            return res.status(400).json({ error: 'Missing audioId' });
        }

        const mp3File = path.join(audioDir, `${audioId}.mp3`);
        if (!fs.existsSync(mp3File)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        console.log('Processing Roblox upload request for audio:', audioId);
        const robloxAssetId = await uploadToRoblox(mp3File);
        
        const response = {
            success: true,
            robloxAssetId: robloxAssetId
        };
        console.log('Upload successful:', response);
        res.json(response);

    } catch (error) {
        console.error('Roblox upload error:', error);
        res.status(500).json({
            error: 'Failed to upload to Roblox',
            details: error.message
        });
    }
});

// Cleanup endpoint
app.post('/api/cleanup', (req, res) => {
    try {
        const files = fs.readdirSync(audioDir);
        const now = Date.now();
        let cleaned = 0;
        let errors = [];

        files.forEach(file => {
            try {
                const filePath = path.join(audioDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > CLEANUP_INTERVAL) {
                    fs.unlinkSync(filePath);
                    cleaned++;
                    console.log('Cleaned up file:', filePath);
                }
            } catch (error) {
                console.error('Error cleaning up file:', file, error);
                errors.push({ file, error: error.message });
            }
        });

        res.json({ 
            message: `Cleaned up ${cleaned} files`,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    try {
        const diskSpace = fs.statSync(audioDir);
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            audioDir: audioDir,
            audioDirExists: fs.existsSync(audioDir),
            platform: process.platform,
            files: fs.readdirSync(audioDir).length,
            diskSpace: {
                free: diskSpace.size,
                used: diskSpace.blocks * diskSpace.blksize
            },
            robloxConfigured: !!(ROBLOX_API_KEY && ROBLOX_CREATOR_ID),
            version: process.env.npm_package_version || '1.0.0',
            uptime: process.uptime()
        });
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle startup
app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
    console.log('Roblox API integration:', ROBLOX_API_KEY && ROBLOX_CREATOR_ID ? 'Configured' : 'Not configured');
});

// Handle process termination
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Cleaning up...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    if (error.fatal) {
        process.exit(1);
    }
});
