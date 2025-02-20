/**
 * server.js
 * Run: node server.js
 * 
 * Expects eSpeak 1.48.04 installed at:
 *   C:\Program Files (x86)\eSpeak\command-line\espeak.exe
 * Adjust the espeakPath if installed elsewhere.
 */

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const port = 3000;

app.use(bodyParser.json());

// Path to the older eSpeak 1.48.04 command-line exe
const espeakPath = "C:\\Program Files (x86)\\eSpeak\\command-line\\espeak.exe";

// Temporary output folder
const outDir = path.join(__dirname, "tts_wav_output");
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
    console.log(`Created temp output folder: ${outDir}`);
}

app.post('/api/tts', async (req, res) => {
    try {
        // Validate request
        if (!req.body || !req.body.text) {
            return res.status(400).json({ error: 'Missing required field: text' });
        }

        const { text, voice = "en", speed = 175 } = req.body;

        // Generate a unique file name
        const fileId = crypto.randomBytes(16).toString('hex');
        const outputFile = path.join(outDir, `audio_${fileId}.wav`);

        // If file already exists for some reason, remove it
        if (fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
        }

        // Build eSpeak arguments
        // eSpeak.exe -v <voice> -s <speed> "<text>" -w <outputFile>
        const args = [
            "-v", voice,
            "-s", speed.toString(),
            text,
            "-w", outputFile
        ];

        // Spawn eSpeak to generate the WAV file
        execFile(espeakPath, args, (error, stdout, stderr) => {
            if (error) {
                console.error("Error generating speech:", error);
                return res.status(500).json({
                    error: "Failed to generate speech",
                    details: error.message
                });
            }

            // Read the generated WAV file
            if (!fs.existsSync(outputFile)) {
                return res.status(500).json({ error: "WAV file was not created." });
            }

            try {
                const fileBuffer = fs.readFileSync(outputFile);
                // Convert to base64
                const base64Data = fileBuffer.toString('base64');

                // Return as JSON
                res.json({ base64: base64Data });
            } catch (err) {
                console.error("Error reading output file:", err);
                return res.status(500).json({ error: err.message });
            } finally {
                // Cleanup: delete the WAV file
                fs.unlink(outputFile, (delErr) => {
                    if (delErr) console.error("Error deleting temp WAV file:", delErr);
                });
            }
        });

    } catch (err) {
        console.error("Server error:", err);
        res.status(500).json({ error: "Internal server error", details: err.message });
    }
});

app.listen(port, () => {
    console.log(`eSpeak 1.48.04 SetAudioData TTS server listening on port ${port}`);
});
