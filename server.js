console.log("Running on platform:", process.platform);


const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Configure paths - always use Linux style since we're in a container
const tempDir = path.join(process.cwd(), 'tts_wav_output');

// Create output directory
try {
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    console.log(`Created temp output folder: ${tempDir}`);
} catch (err) {
    console.error(`Failed to create output directory: ${err.message}`);
    process.exit(1);
}

app.use(bodyParser.json());

app.post('/api/tts', (req, res) => {
    try {
        if (!req.body || !req.body.text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }

        const { text, voice = 'en', speed = 175 } = req.body;
        const audio_id = crypto.randomBytes(16).toString('hex');
        const outputFile = path.join(tempDir, `audio_${audio_id}.wav`);

        // Clean up any existing file
        if (fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
        }

        const args = [
            '-v', voice,
            '-s', speed.toString(),
            text,
            '-w', outputFile
        ];

        console.log('Executing command: espeak', args.join(' '));

        // Use 'espeak' directly without Windows path
        const espeak = spawn('espeak', args);

        let errorOutput = '';
        let standardOutput = '';

        espeak.stdout.on('data', (data) => {
            standardOutput += data;
            console.log(`stdout: ${data}`);
        });

        espeak.stderr.on('data', (data) => {
            errorOutput += data;
            console.error(`stderr: ${data}`);
        });

        espeak.on('error', (error) => {
            console.error('Error generating speech:', error);
            return res.status(500).json({
                error: 'Failed to generate speech',
                details: error.message
            });
        });

        espeak.on('close', (code) => {
            console.log(`Process exited with code ${code}`);
            
            setTimeout(() => {
                try {
                    if (fs.existsSync(outputFile)) {
                        const stats = fs.statSync(outputFile);
                        if (stats.size > 0) {
                            return res.json({
                                audio_id: audio_id,
                                duration: (stats.size / (22050 * 2)) || 1,
                                file_size: stats.size
                            });
                        } else {
                            throw new Error('Output file is empty');
                        }
                    } else {
                        throw new Error('Output file was not created');
                    }
                } catch (error) {
                    console.error('Error checking output file:', error);
                    return res.status(500).json({
                        error: error.message,
                        command: `espeak ${args.join(' ')}`,
                        stderr: errorOutput,
                        stdout: standardOutput
                    });
                }
            }, 1000);
        });

    } catch (error) {
        console.error("Server error:", error);
        return res.status(500).json({ 
            error: "Internal server error", 
            details: error.message 
        });
    }
});

app.get('/audio/:id', (req, res) => {
    const audioFile = path.join(tempDir, `audio_${req.params.id}.wav`);
    if (fs.existsSync(audioFile)) {
        res.type('audio/wav');  // Explicitly set the MIME type
        res.sendFile(audioFile);
    } else {
        res.status(404).json({ error: "Audio file not found" });
    }
});


app.listen(port, () => {
    console.log(`eSpeak TTS server listening on port ${port}`);
});
