const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const app = express();
const port = process.env.PORT || 8080;

// Roblox API configuration
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const ROBLOX_CREATOR_ID = process.env.ROBLOX_CREATOR_ID;

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

// Function to run espeak and generate a WAV file
function runEspeak(args) {
    return new Promise((resolve, reject) => {
        console.log('Executing command: espeak', args.join(' '));
        const espeak = spawn('espeak', args);
        let errorOutput = '';
        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('eSpeak stderr:', data.toString());
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

// Function to convert a WAV file to MP3 using FFmpeg
function convertToMp3(wavFile, mp3File) {
    return new Promise((resolve, reject) => {
        console.log('Converting WAV to MP3:', wavFile, '->', mp3File);
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

// Function to upload audio to Roblox
async function uploadToRoblox(audioPath) {
    if (!ROBLOX_API_KEY) {
        throw new Error('ROBLOX_API_KEY not configured');
    }

    const audioData = fs.readFileSync(audioPath);
    
    const response = await fetch('https://apis.roblox.com/assets/v1/assets', {
        method: 'POST',
        headers: {
            'x-api-key': ROBLOX_API_KEY,
            'Content-Type': 'audio/mpeg'
        },
        body: audioData
    });

    if (!response.ok) {
        throw new Error(`Roblox upload failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.id;
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
        
        // Create a unique hash for the audio
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(audioDir, `${hash}.wav`);
        const mp3File = path.join(audioDir, `${hash}.mp3`);
        
        // If MP3 already exists, return it
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
        if (!fs.existsSync(wavFile)) {
            const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
            await runEspeak(args);
        }
        
        await convertToMp3(wavFile, mp3File);
        
        // Clean up WAV file
        if (fs.existsSync(wavFile)) {
            fs.unlinkSync(wavFile);
        }
        
        const stats = fs.statSync(mp3File);
        const duration = (stats.size / (44100 * (128/8))) || 1;
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        
        const response = {
            audio_id: hash,
            duration: duration,
            file_size: stats.size,
            url: `${baseUrl}/audio/${hash}.mp3`
        };
        console.log('Sending response:', response);
        res.json(response);
        
    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// New endpoint to upload to Roblox
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

// Cleanup endpoint
app.post('/api/cleanup', (req, res) => {
    try {
        const files = fs.readdirSync(audioDir);
        const now = Date.now();
        let cleaned = 0;
        files.forEach(file => {
            const filePath = path.join(audioDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 3600000) {
                fs.unlinkSync(filePath);
                cleaned++;
            }
        });
        res.json({ message: `Cleaned up ${cleaned} files` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        audioDir: audioDir,
        audioDirExists: fs.existsSync(audioDir),
        platform: process.platform,
        files: fs.readdirSync(audioDir).length,
        robloxConfigured: !!ROBLOX_API_KEY
    });
});

app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
    console.log('Roblox API integration:', ROBLOX_API_KEY ? 'Configured' : 'Not configured');
});
