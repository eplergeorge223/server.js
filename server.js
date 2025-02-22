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

// Validation function for environment variables
function validateConfig() {
    const missing = [];
    if (!ROBLOX_API_KEY) missing.push('ROBLOX_API_KEY');
    if (!ROBLOX_CREATOR_ID) missing.push('ROBLOX_CREATOR_ID');
    if (missing.length > 0) {
        console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
        return false;
    }
    return true;
}

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

// Enhanced error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Improved espeak function with more robust error handling
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
            '-y', // Overwrite output file if it exists
            mp3File
        ]);

        let errorOutput = '';

        ffmpeg.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('FFmpeg stderr:', data.toString());
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                // Verify the output file exists and has size
                if (fs.existsSync(mp3File) && fs.statSync(mp3File).size > 0) {
                    resolve();
                } else {
                    reject(new Error('FFmpeg conversion failed: Output file is empty or missing'));
                }
            } else {
                reject(new Error(`FFmpeg exited with code ${code}: ${errorOutput}`));
            }
        });

        ffmpeg.on('error', (error) => {
            console.error('FFmpeg process error:', error);
            reject(error);
        });
    });
}

// Improved Roblox upload function
async function uploadToRoblox(audioPath) {
    if (!validateConfig()) {
        throw new Error('Missing required Roblox configuration');
    }

    const fileStats = fs.statSync(audioPath);
    if (fileStats.size > MAX_AUDIO_SIZE) {
        throw new Error(`File size ${fileStats.size} exceeds maximum allowed size of ${MAX_AUDIO_SIZE}`);
    }

    const form = new FormData();
    
    // Add required fields
    form.append('file', fs.createReadStream(audioPath));
    form.append('creatorId', ROBLOX_CREATOR_ID);
    form.append('assetType', 'Audio');
    form.append('displayName', path.basename(audioPath, '.mp3'));
    
    try {
        const response = await fetch('https://apis.roblox.com/assets/v1/assets', {
            method: 'POST',
            headers: {
                'x-api-key': ROBLOX_API_KEY,
                ...form.getHeaders()
            },
            body: form
        });

        if (!response.ok) {
            let errorText = await response.text();
            try {
                errorText = JSON.parse(errorText);
            } catch (e) {
                // If it's not JSON, use the text as-is
            }
            throw new Error(`Roblox upload failed: ${response.statusText}\nDetails: ${JSON.stringify(errorText)}`);
        }

        const data = await response.json();
        return data.id;
    } catch (error) {
        console.error('Upload error details:', error);
        throw error;
    }
}

// Serve audio files statically with caching headers
app.use('/audio', (req, res, next) => {
    res.header('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    express.static(audioDir)(req, res, next);
});

// Main TTS endpoint with improved error handling and validation
app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        
        // Input validation
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        if (text.length > 1000) {
            return res.status(400).json({ error: 'Text exceeds maximum length of 1000 characters' });
        }
        if (speed < 80 || speed > 500) {
            return res.status(400).json({ error: 'Speed must be between 80 and 500' });
        }
        
        // Create a unique hash for the audio
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(audioDir, `${hash}.wav`);
        const mp3File = path.join(audioDir, `${hash}.mp3`);
        
        // Check for existing MP3
        if (fs.existsSync(mp3File)) {
            console.log(`Audio for "${text}" already exists as MP3. Returning cached version.`);
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
        
        // Generate new audio file
        const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
        await runEspeak(args);
        await convertToMp3(wavFile, mp3File);
        
        // Clean up WAV file
        if (fs.existsSync(wavFile)) {
            fs.unlinkSync(wavFile);
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

// Improved Roblox upload endpoint
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

        const robloxAssetId = await uploadToRoblox(mp3File);
        
        res.json({
            success: true,
            robloxAssetId: robloxAssetId
        });

    } catch (error) {
        console.error('Roblox upload error:', error);
        res.status(500).json({
            error: 'Failed to upload to Roblox',
            details: error.message
        });
    }
});

// Improved cleanup endpoint with better file handling
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
                }
            } catch (error) {
                errors.push({ file, error: error.message });
            }
        });

        res.json({ 
            message: `Cleaned up ${cleaned} files`,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Enhanced health check endpoint
app.get('/health', (req, res) => {
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
        robloxConfigured: validateConfig(),
        version: process.env.npm_package_version || '1.0.0',
        uptime: process.uptime()
    });
});

// Automatic cleanup every hour
setInterval(() => {
    console.log('Running automated cleanup...');
    fetch(`http://localhost:${port}/api/cleanup`, { method: 'POST' })
        .catch(error => console.error('Automated cleanup failed:', error));
}, CLEANUP_INTERVAL);

// Start server
app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
    console.log('Roblox API integration:', validateConfig() ? 'Configured' : 'Not configured');
});

// Handle process termination gracefully
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Cleaning up...');
    // Perform any necessary cleanup
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    // Log error and exit if it's fatal
    if (error.fatal) {
        process.exit(1);
    }
});
