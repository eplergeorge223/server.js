const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Configuration with validation
const config = {
    port: parseInt(process.env.PORT) || 8080,
    robloxApiKey: process.env.ROBLOX_API_KEY,
    robloxCreatorId: process.env.ROBLOX_CREATOR_ID,
    maxAudioSize: 20 * 1024 * 1024, // 20MB
    cleanupInterval: 3600000, // 1 hour
    retryDelay: 2000,
    maxTextLength: 1000,
    audioDir: path.join(process.cwd(), 'audio'),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    espeakPath: process.env.ESPEAK_PATH || 'espeak',
    
    validate() {
        if (!this.robloxApiKey || !this.robloxCreatorId) {
            console.warn('⚠️ Roblox API credentials not configured');
        }
        if (!fsSync.existsSync(this.audioDir)) {
            fsSync.mkdirSync(this.audioDir, { recursive: true });
            console.log('📁 Created audio directory:', this.audioDir);
        }
    }
};

const app = express();

// Middleware
app.use(express.json());
app.use(helmet());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later' }
}));

// CORS configuration
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Utility to get audio duration using FFmpeg
async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(config.ffmpegPath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);

        let output = '';
        ffprobe.stdout.on('data', (data) => output += data);
        
        ffprobe.on('close', (code) => {
            if (code === 0) {
                const duration = parseFloat(output.trim());
                resolve(isNaN(duration) ? 0 : duration);
            } else {
                resolve(0); // Fallback duration
            }
        });
        
        ffprobe.on('error', () => resolve(0));
    });
}

// Enhanced espeak wrapper
async function runEspeak(text, voice, speed, outputPath) {
    return new Promise((resolve, reject) => {
        const process = spawn(config.espeakPath, [
            '-v', voice,
            '-s', speed.toString(),
            text,
            '-w', outputPath
        ]);

        let errorOutput = '';
        process.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('🎤 eSpeak:', data.toString());
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

// Enhanced audio conversion
async function convertToMp3(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const process = spawn(config.ffmpegPath, [
            '-i', inputPath,
            '-acodec', 'libmp3lame',
            '-ab', '128k',
            '-ar', '44100',
            '-y',
            outputPath
        ]);

        let errorOutput = '';
        process.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('🎵 FFmpeg:', data.toString());
        });

        const timeout = setTimeout(() => {
            process.kill();
            reject(new Error('FFmpeg process timed out'));
        }, 30000);

        process.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && fsSync.existsSync(outputPath)) {
                resolve();
            } else {
                reject(new Error(`FFmpeg failed (${code}): ${errorOutput}`));
            }
        });
    });
}

// Improved Roblox upload with retries
async function uploadAudioToRoblox(audioPath, maxRetries = 3) {
    if (!config.robloxApiKey || !config.robloxCreatorId) {
        throw new Error('Roblox API credentials not configured');
    }

    const stats = await fs.stat(audioPath);
    if (stats.size > config.maxAudioSize) {
        throw new Error(`File exceeds maximum size (${config.maxAudioSize} bytes)`);
    }

    let lastError = null;
    let xsrfToken = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const form = new FormData();
            form.append('fileContent', fsSync.createReadStream(audioPath));
            form.append('displayName', path.basename(audioPath, '.mp3'));
            form.append('creatorId', config.robloxCreatorId);
            form.append('assetType', 'Audio');

            console.log(`📤 Upload attempt ${attempt}/${maxRetries}:`, {
                file: path.basename(audioPath),
                size: stats.size
            });

            const response = await fetch('https://publish.roblox.com/v1/audio', {
                method: 'POST',
                headers: {
                    'x-api-key': config.robloxApiKey,
                    'x-csrf-token': xsrfToken,
                    ...form.getHeaders()
                },
                body: form,
                timeout: 30000
            });

            if (response.status === 403) {
                xsrfToken = response.headers.get('x-csrf-token');
                if (xsrfToken) {
                    console.log('🔄 Retrieved new XSRF token');
                    continue;
                }
                throw new Error('Failed to get XSRF token');
            }

            if (response.status === 408 || response.status >= 500) {
                const delay = attempt * 5000;
                console.log(`⏳ Received ${response.status}, waiting ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            const data = await response.json().catch(() => ({}));
            
            if (!response.ok) {
                throw new Error(`Upload failed: ${response.status} ${JSON.stringify(data)}`);
            }

            return data.id || data.assetId;

        } catch (error) {
            console.error(`❌ Upload attempt ${attempt} failed:`, error);
            lastError = error;
            
            if (attempt === maxRetries) {
                throw new Error(`Upload failed after ${maxRetries} attempts: ${lastError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, attempt * 5000));
        }
    }
}

// Static audio files serving
app.use('/audio', express.static(config.audioDir));

// Main TTS endpoint
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;

        // Validation
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

        console.log('🎯 Processing TTS request:', { text, voice, speed, hash });

        // Check cache
        if (fsSync.existsSync(mp3File)) {
            console.log('📎 Cache hit:', hash);
            const duration = await getAudioDuration(mp3File);
            const stats = await fs.stat(mp3File);
            
            return res.json({
                audio_id: hash,
                duration,
                file_size: stats.size,
                url: `https://${req.get('host')}/audio/${hash}.mp3`
            });
        }

        // Generate new audio
        await runEspeak(text, voice, speed, wavFile);
        await convertToMp3(wavFile, mp3File);
        
        // Cleanup WAV file
        await fs.unlink(wavFile).catch(console.error);
        
        const duration = await getAudioDuration(mp3File);
        const stats = await fs.stat(mp3File);

        const response = {
            audio_id: hash,
            duration,
            file_size: stats.size,
            url: `https://${req.get('host')}/audio/${hash}.mp3`
        };

        console.log('✅ Success:', response);
        res.json(response);

    } catch (error) {
        console.error('❌ TTS error:', error);
        res.status(500).json({
            error: 'TTS processing failed',
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

        const mp3File = path.join(config.audioDir, `${audioId}.mp3`);
        if (!fsSync.existsSync(mp3File)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        console.log('🎮 Processing Roblox upload:', audioId);
        const robloxAssetId = await uploadAudioToRoblox(mp3File);
        
        res.json({
            success: true,
            robloxAssetId
        });

    } catch (error) {
        console.error('❌ Roblox upload error:', error);
        res.status(500).json({
            error: 'Roblox upload failed',
            details: error.message
        });
    }
});

// Cleanup endpoint
app.post('/api/cleanup', async (req, res) => {
    try {
        const files = await fs.readdir(config.audioDir);
        const now = Date.now();
        let cleaned = 0;
        let errors = [];

        for (const file of files) {
            try {
                const filePath = path.join(config.audioDir, file);
                const stats = await fs.stat(filePath);
                if (now - stats.mtimeMs > config.cleanupInterval) {
                    await fs.unlink(filePath);
                    cleaned++;
                    console.log('🧹 Cleaned:', filePath);
                }
            } catch (error) {
                console.error('❌ Cleanup error:', file, error);
                errors.push({ file, error: error.message });
            }
        }

        res.json({
            message: `Cleaned ${cleaned} files`,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('❌ Cleanup error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        const diskSpace = await fs.stat(config.audioDir);
        const files = await fs.readdir(config.audioDir);
        
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            audioDir: config.audioDir,
            files: files.length,
            diskSpace: {
                size: diskSpace.size,
                used: diskSpace.blocks * diskSpace.blksize
            },
            robloxConfigured: !!(config.robloxApiKey && config.robloxCreatorId),
            version: process.env.npm_package_version || '1.0.0',
            uptime: process.uptime()
        });
    } catch (error) {
        console.error('❌ Health check error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
});

// Startup
config.validate();
app.listen(config.port, () => {
    console.log(`
🚀 TTS Server Started
📡 Port: ${config.port}
💾 Audio directory: ${config.audioDir}
🎮 Roblox API: ${config.robloxApiKey ? 'Configured' : 'Not configured'}
⚙️  Platform: ${process.platform}
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('📥 SIGTERM received, shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
    if (error.fatal) {
        process.exit(1);
    }
});
