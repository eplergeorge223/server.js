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

// Serve audio files statically
app.use('/audio', express.static(audioDir));

app.post('/api/tts', async (req, res) => {
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        
        // Create a unique hash for the audio
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(audioDir, `${hash}.wav`);
        
        // Check if file already exists
        if (!fs.existsSync(wavFile)) {
            // Generate WAV file
            const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
            await runEspeak(args);
        }
        
        // Get file stats
        const stats = fs.statSync(wavFile);
        const fileSize = stats.size;
        
        // Calculate duration (assuming 44.1kHz, 16-bit, mono)
        const headerSize = 44; // WAV header size
        const duration = (fileSize - headerSize) / (44100 * 2);
        
        // Get the base URL from the request
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        
        const response = {
            audio_id: hash,
            duration: duration,
            file_size: fileSize,
            url: `${baseUrl}/audio/${hash}.wav`
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

// Add file cleanup endpoint (optional, for maintenance)
app.post('/api/cleanup', (req, res) => {
    try {
        const files = fs.readdirSync(audioDir);
        const now = Date.now();
        let cleaned = 0;
        
        files.forEach(file => {
            const filePath = path.join(audioDir, file);
            const stats = fs.statSync(filePath);
            // Remove files older than 1 hour
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
        files: fs.readdirSync(audioDir).length
    });
});

app.listen(port, () => {
    console.log('Running on platform:', process.platform);
    console.log(`eSpeak TTS server listening on port ${port}`);
});
