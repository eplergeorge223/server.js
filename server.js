const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const port = process.env.PORT || 8080;

// Debug middleware to log all requests
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
});

app.use(express.json());

const tempDir = path.join(process.cwd(), 'tts_wav_output');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// CORS middleware with debug logging
app.use((req, res, next) => {
    console.log('Setting CORS headers');
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    
    // Intercept response to log what's being sent
    const originalJson = res.json;
    res.json = function(body) {
        console.log('Response body before sending:', body);
        return originalJson.call(this, body);
    };
    
    next();
});

function runEspeak(args) {
    return new Promise((resolve, reject) => {
        console.log('Running espeak with args:', args);
        const espeak = spawn('espeak', args);
        
        let errorOutput = '';
        let stdOutput = '';
        
        espeak.stdout.on('data', (data) => {
            stdOutput += data;
            console.log('espeak stdout:', data.toString());
        });
        
        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.log('espeak stderr:', data.toString());
        });
        
        espeak.on('close', (code) => {
            console.log(`espeak process exited with code ${code}`);
            if (code !== 0) {
                return reject(new Error(`eSpeak failed with code ${code}: ${errorOutput}`));
            }
            resolve();
        });
        
        espeak.on('error', (err) => {
            console.error('espeak process error:', err);
            reject(err);
        });
    });
}

function convertToRawPCM(wavFile) {
    return new Promise((resolve, reject) => {
        console.log('Converting to PCM:', wavFile);
        const ffmpeg = spawn('ffmpeg', [
            '-i', wavFile,
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ar', '44100',
            '-ac', '1',
            '-'
        ]);
        
        const chunks = [];
        ffmpeg.stdout.on('data', (chunk) => {
            chunks.push(chunk);
            console.log('Received PCM chunk of size:', chunk.length);
        });
        
        ffmpeg.stderr.on('data', (data) => {
            console.log('FFmpeg stderr:', data.toString());
        });
        
        ffmpeg.on('close', (code) => {
            console.log(`FFmpeg process exited with code ${code}`);
            if (code === 0) {
                const finalBuffer = Buffer.concat(chunks);
                console.log('Final PCM buffer size:', finalBuffer.length);
                resolve(finalBuffer);
            } else {
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            console.error('FFmpeg process error:', err);
            reject(err);
        });
    });
}

// Test endpoint
app.post('/api/test', (req, res) => {
    const testResponse = {
        audio_id: 'test',
        audio_data: 'test_data',
        duration: 1.0,
        file_size: 1000
    };
    console.log('Test endpoint response:', testResponse);
    res.json(testResponse);
});

// Main TTS endpoint
app.post('/api/tts', async (req, res) => {
    console.log('Received TTS request:', req.body);
    
    try {
        const { text, voice = 'en', speed = 175 } = req.body;
        if (!text) {
            console.log('Missing text field');
            return res.status(400).json({ error: 'Missing required field: text' });
        }
        
        const hash = crypto.createHash('md5').update(text + voice + speed).digest('hex');
        const wavFile = path.join(tempDir, `audio_${hash}.wav`);
        console.log('Generated WAV file path:', wavFile);
        
        const args = ['-v', voice, '-s', speed.toString(), text, '-w', wavFile];
        
        console.log('Starting TTS processing');
        await runEspeak(args);
        console.log('TTS processing complete');
        
        const audioData = await convertToRawPCM(wavFile);
        console.log('PCM conversion complete, data size:', audioData.length);
        
        const fileSize = fs.statSync(wavFile).size;
        console.log('Original WAV file size:', fileSize);
        
        fs.unlink(wavFile, (err) => {
            if (err) console.error(`Failed to delete ${wavFile}: ${err}`);
            else console.log('WAV file cleaned up successfully');
        });
        
        const duration = audioData.length / (44100 * 2);
        
        const response = {
            audio_id: hash,
            audio_data: audioData.toString('base64'),
            duration: duration,
            file_size: fileSize,
            format: {
                sampleRate: 44100,
                channels: 1,
                bitDepth: 16
            }
        };
        
        console.log('Preparing response:', {
            ...response,
            audio_data: `[Base64 string length: ${response.audio_data.length}]`
        });
        
        res.json(response);
        
        console.log('Response sent successfully');
        
    } catch (error) {
        console.error('TTS error:', error);
        res.status(500).json({
            error: 'Internal server error',
            details: error.message
        });
    }
});

// Add a basic GET endpoint for testing connectivity
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
    console.log(`eSpeak TTS server listening on port ${port} at ${new Date().toISOString()}`);
    console.log(`Temporary directory: ${tempDir}`);
});

// Handle process termination
process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Cleaning up...');
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
        fs.readdirSync(tempDir).forEach((file) => {
            fs.unlinkSync(path.join(tempDir, file));
        });
    }
    process.exit(0);
});
