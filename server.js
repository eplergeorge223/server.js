const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 8080;

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

// Function to run espeak and generate a WAV file.
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

// Function to convert a WAV file to MP3 using FFmpeg.
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

// Serve audio files statically
app.use('/audio', express.static(audioDir));

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        
        // Create a unique hash for the audio.
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(audioDir, `${hash}.wav`);
        const mp3File = path.join(audioDir, `${hash}.mp3`);
        
        // If MP3 already exists, return it.
        if (fs.existsSync(mp3File)) {
            console.log(`Audio for "${text}" already exists as MP3. Returning cached version.`);
            const stats = fs.statSync(mp3File);
            // Duration calculation here is a rough estimate.
            const duration = (stats.size / (44100 * (128/8))) || 1;
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            return res.json({
                audio_id: hash,
                duration: duration,
                file_size: stats.size,
                url: `${baseUrl}/audio/${hash}.mp3`
            });
        }
        
        // If MP3 doesn't exist, generate the WAV file first.
        if (!fs.existsSync(wavFile)) {
            const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
            await runEspeak(args);
        }
        
        // Convert the WAV file to MP3.
        await convertToMp3(wavFile, mp3File);
        
        // Remove the WAV file after conversion.
        if (fs.existsSync(wavFile)) {
            fs.unlinkSync(wavFile);
        }
        
        // Get MP3 file stats.
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

// Optional endpoint to clean up old files.
app.post('/api/cleanup', (req, res) => {
    try {
        const files = fs.readdirSync(audioDir);
        const now = Date.now();
        let cleaned = 0;
        files.forEach(file => {
            const filePath = path.join(audioDir, file);
            const stats = fs.statSync(filePath);
            // Remove files older than 1 hour.
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

// Health check endpoint.
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        audioDir: audioDir,
        audioDirExists: fs.existsSync(audioDir),
        platform: process.platform,
        files: fs.readdirSync(audioDir).length
    });
});

app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
});
