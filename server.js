const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');
const app = express();

// Configuration
const config = {
port: process.env.PORT || 8080,
robloxApiKey: process.env.ROBLOX_API_KEY,
robloxCreatorId: process.env.ROBLOX_CREATOR_ID,
robloxSecurityCookie: process.env.ROBLOX_SECURITY_COOKIE,
maxAudioSize: 20 * 1024 * 1024, // 20MB
cleanupInterval: 3600000, // 1 hour
retryDelay: 2000,
maxTextLength: 1000,
audioDir: path.join(process.cwd(), 'audio')
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
function getAudioDuration(filePath) {
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

    ffprobe.on('error', () => resolve(0));
});
}

// Enhanced espeak function
function runEspeak(text, voice, speed, outputPath) {
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
function convertToMp3(inputPath, outputPath) {
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
// Improved Roblox upload function with proper file handling
async function uploadAudioToRoblox(audioPath, maxRetries = 3) {
    if (!config.robloxApiKey || !config.robloxCreatorId || !config.robloxSecurityCookie) {
        throw new Error('Roblox API credentials or security cookie not configured');
    }

    const stats = fs.statSync(audioPath);
    if (stats.size > config.maxAudioSize) {
        throw new Error(`File exceeds maximum size (${config.maxAudioSize} bytes)`);
    }

    let lastError = null;
    let xsrfToken = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Create a new FormData instance for each attempt
            const form = new FormData();
            
            // Read the file into a Buffer
            const fileBuffer = fs.readFileSync(audioPath);
            
            // Append the file with proper metadata
            form.append('file', fileBuffer, {
                filename: path.basename(audioPath),
                contentType: 'audio/mpeg',
                knownLength: stats.size
            });
            
            form.append('name', path.basename(audioPath, '.mp3'));
            form.append('creatorTargetId', config.robloxCreatorId);
            form.append('creatorType', 'User');
            form.append('description', 'TTS Audio');
            form.append('paymentModalType', 'None');

            console.log(`Upload attempt ${attempt}/${maxRetries}:`, {
                file: path.basename(audioPath),
                size: stats.size,
                formData: {
                    name: path.basename(audioPath, '.mp3'),
                    creatorTargetId: config.robloxCreatorId,
                    contentType: 'audio/mpeg'
                }
            });

            const response = await fetch('https://publish.roblox.com/v1/audio', {
                method: 'POST',
                headers: {
                    'x-api-key': config.robloxApiKey,
                    'x-csrf-token': xsrfToken || '',
                    'Cookie': `.ROBLOSECURITY=${config.robloxSecurityCookie.trim()}`,
                    ...form.getHeaders()
                },
                body: form,
                timeout: 30000
            });

            if (response.status === 403 && !xsrfToken) {
                xsrfToken = response.headers.get('x-csrf-token');
                if (xsrfToken) {
                    console.log('Retrieved new XSRF token');
                    continue;
                }
            }

            const data = await response.json().catch(() => ({}));
            
            if (!response.ok) {
                throw new Error(`Upload failed: ${response.status} ${JSON.stringify(data)}`);
            }

            console.log('Upload successful:', data);
            return data.audioAssetId || data.assetId;

        } catch (error) {
            console.error(`Upload attempt ${attempt} failed:`, error);
            lastError = error;
            
            if (attempt === maxRetries) {
                throw new Error(`Upload failed after ${maxRetries} attempts: ${lastError.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, attempt * 5000));
        }
    }
}

// Serve audio files
app.use('/audio', express.static(config.audioDir));

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

    const host = req.get('host').replace(/'/g, '').trim();

    if (fs.existsSync(mp3File)) {
        console.log('Cache hit:', hash);
        const duration = await getAudioDuration(mp3File);
        const stats = fs.statSync(mp3File);
        
        return res.json({
            audio_id: hash,
            duration,
            file_size: stats.size,
            url: `https://${host}/audio/${hash}.mp3`
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

    const response = {
        audio_id: hash,
        duration,
        file_size: stats.size,
        url: `https://${host}/audio/${hash}.mp3`
    };

    console.log('Success:', response);
    res.json(response);

} catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({
        error: 'TTS processing failed',
        details: error.message
    });
}
});

// Enhanced Roblox upload endpoint with better error handling
app.post('/api/upload-to-roblox', async (req, res) => {
try {
const { audioId } = req.body;
if (!audioId) {
return res.status(400).json({ error: 'Missing audioId' });
}


    const mp3File = path.join(config.audioDir, `${audioId}.mp3`);
    console.log('Attempting to upload file:', mp3File);
    
    if (!fs.existsSync(mp3File)) {
        return res.status(404).json({ error: 'Audio file not found' });
    }

    // Log file stats
    const stats = fs.statSync(mp3File);
    console.log('File stats:', {
        size: stats.size,
        permissions: stats.mode,
        created: stats.birthtime,
        modified: stats.mtime
    });

    console.log('Processing Roblox upload:', audioId);
    const robloxAssetId = await uploadAudioToRoblox(mp3File);
    
    console.log('Upload successful, asset ID:', robloxAssetId);
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

// Cleanup endpoint
app.post('/api/cleanup', (req, res) => {
try {
const files = fs.readdirSync(config.audioDir);
const now = Date.now();
let cleaned = 0;
let errors = [];


    files.forEach(file => {
        try {
            const filePath = path.join(config.audioDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > config.cleanupInterval) {
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
        message: `Cleaned ${cleaned} files`,
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
const stats = fs.statSync(config.audioDir);
res.json({
status: 'ok',
timestamp: new Date().toISOString(),
audioDir: config.audioDir,
files: fs.readdirSync(config.audioDir).length,
diskSpace: {
size: stats.size,
used: stats.blocks * stats.blksize
},
robloxConfigured: !!(config.robloxApiKey && config.robloxCreatorId && config.robloxSecurityCookie),
version: process.env.npm_package_version || '1.0.0',
uptime: process.uptime()
});
} catch (error) {
console.error('Health check error:', error);
res.status(500).json({ error: error.message });
}
});

// Error handling
process.on('uncaughtException', (error) => {
console.error('Uncaught exception:', error);
if (error.fatal) {
process.exit(1);
}
});

// Start server
app.listen(config.port, () => {
console.log(`
TTS Server Started

Port: ${config.port}
Audio directory: ${config.audioDir}
Roblox API: ${config.robloxApiKey ? 'Configured' : 'Not configured'}
Roblox Creator ID: ${config.robloxCreatorId ? 'Configured' : 'Not configured'}
Roblox Security Cookie: ${config.robloxSecurityCookie ? 'Configured' : 'Not configured'}
Platform: ${process.platform} `); });
