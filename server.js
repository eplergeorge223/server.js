const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Optionally, load environment variables (e.g., API key, creator ID) if using a .env file
// require('dotenv').config();

const app = express();
app.use(express.json());

// Configuration – set your Roblox API key (preferred) or .ROBLOSECURITY cookie and creator info
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY || "";       // Your Open Cloud API key
const ROBLOX_SECURITY_COOKIE = process.env.ROBLOX_SECURITY || ""; // Your .ROBLOSECURITY (if using cookie auth)
const CREATOR_TYPE = process.env.CREATOR_TYPE || "User";         // "User" or "Group"
const CREATOR_ID = process.env.CREATOR_ID || "";                 // ID of the user or group to upload to
const MAX_RETRIES = 5;      // max retry attempts for upload
const BASE_RETRY_DELAY = 500; // base delay in ms for exponential backoff

// Directory for storing generated audio files
const AUDIO_DIR = path.join(process.cwd(), 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  console.log('Created audio directory:', AUDIO_DIR);
}

/**
 * TTS generation function.
 * Replace this stub with your actual TTS logic.
 * It should generate an MP3 file from the given text and return its file path.
 */
async function generateTTSAudio(text, voice = "en", speed = 175) {
  // For caching, create a hash from the parameters.
  const hash = crypto.createHash('md5').update(`${text}${voice}${speed}`).digest('hex');
  const mp3File = path.join(AUDIO_DIR, `${hash}.mp3`);

  // If file already exists, simply return its path.
  if (fs.existsSync(mp3File)) {
    return { audioFilePath: mp3File, audioId: hash };
  }

  // Otherwise, generate the audio.
  // Replace the following dummy code with your TTS engine (e.g., espeak, an external API, etc.)
  fs.writeFileSync(mp3File, "DUMMY AUDIO CONTENT");
  // Optionally, compute duration and file size here.
  return { audioFilePath: mp3File, audioId: hash };
}

/**
 * POST /api/tts
 * Expects JSON: { text, voice, speed }
 * Returns JSON: { audio_id, duration, file_size, url }
 */
app.post('/api/tts', async (req, res) => {
  const { text, voice = "en", speed = 175 } = req.body;
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "No text provided for TTS." });
  }

  let audioResult;
  try {
    audioResult = await generateTTSAudio(text, voice, speed);
  } catch (err) {
    console.error("TTS generation failed:", err);
    return res.status(500).json({ error: `TTS generation failed: ${err.message}` });
  }

  const { audioFilePath, audioId } = audioResult;

  // Read the generated audio file to get its size (duration could be computed with a tool, here we set a dummy value)
  let audioData;
  try {
    audioData = fs.readFileSync(audioFilePath);
  } catch (err) {
    console.error("Error reading audio file:", err);
    return res.status(500).json({ error: "Failed to read generated audio file." });
  }
  const stats = fs.statSync(audioFilePath);
  // For demo, we use a dummy duration of 1.0 seconds.
  const duration = 1.0;

  // Build the URL from which the audio file can be fetched (adjust host as needed)
  // For example, if you are serving static files from the audio folder:
  const host = req.get('host');
  const url = `https://${host}/audio/${audioId}.mp3`;

  // Return response with audio_id and metadata.
  return res.status(200).json({
    audio_id: audioId,
    duration: duration,
    file_size: stats.size,
    url: url
  });
});

/**
 * POST /api/upload-to-roblox
 * Expects JSON: { audioId }
 * Reads the corresponding MP3 file and uploads it to Roblox.
 * Returns JSON: { robloxAssetId }
 */
app.post('/api/upload-to-roblox', async (req, res) => {
  const { audioId } = req.body;
  if (!audioId) {
    return res.status(400).json({ error: "Missing audioId" });
  }

  const mp3File = path.join(AUDIO_DIR, `${audioId}.mp3`);
  console.log('Attempting to upload file:', mp3File);
  
  if (!fs.existsSync(mp3File)) {
    return res.status(404).json({ error: "Audio file not found" });
  }

  // Log file stats
  const stats = fs.statSync(mp3File);
  console.log('File stats:', {
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime
  });

  // Prepare form data for Roblox upload
  const formData = new FormData();
  if (!CREATOR_ID) {
    console.error("CREATOR_ID is not configured.");
    return res.status(500).json({ error: "Server configuration error: Creator ID not set." });
  }
  const assetName = `TTS Audio ${Date.now()}`;
  const requestPayload = {
    assetType: "Audio",
    creationContext: {
      creator: {}
    },
    description: "Text-to-Speech audio upload",
    displayName: assetName
  };
  if (CREATOR_TYPE.toLowerCase() === "group") {
    requestPayload.creationContext.creator.groupId = Number(CREATOR_ID);
  } else {
    requestPayload.creationContext.creator.userId = Number(CREATOR_ID);
  }
  formData.append('request', JSON.stringify(requestPayload), { contentType: 'application/json' });
  formData.append('fileContent', fs.readFileSync(mp3File), "ttsAudio.mp3");

  // Set up headers for the request
  const useOpenCloud = !!ROBLOX_API_KEY;  // true if using API key auth
  const headers = { 
    ...formData.getHeaders()  // includes proper Content-Type with boundary
  };
  if (useOpenCloud) {
    headers['x-api-key'] = ROBLOX_API_KEY;
  } else if (ROBLOX_SECURITY_COOKIE) {
    headers['Cookie'] = `.ROBLOSECURITY=${ROBLOX_SECURITY_COOKIE}`;
  }

  const uploadUrl = useOpenCloud 
    ? "https://apis.roblox.com/assets/v1/assets"  // Open Cloud Assets API endpoint
    : "https://www.roblox.com/asset/request-upload";  // Legacy endpoint (if applicable)

  // Attempt to upload with retries and exponential backoff
  let responseData;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(uploadUrl, formData, { headers });
      responseData = response.data;
      break;
    } catch (err) {
      // If using cookie auth, check for CSRF token
      if (!useOpenCloud && err.response && err.response.status === 403) {
        const csrfToken = err.response.headers['x-csrf-token'];
        if (csrfToken) {
          headers['X-CSRF-TOKEN'] = csrfToken;
          console.warn("Received CSRF token, retrying upload with token.");
          continue;
        }
      }
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const status = err.response ? err.response.status : null;
        if (!err.response || status === 429 || status >= 500) {
          const delay = Math.pow(2, attempt) * BASE_RETRY_DELAY;
          console.warn(`Upload attempt ${attempt} failed (status: ${status || err.message}). Retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      break;
    }
  }

  if (!responseData) {
    if (lastError) {
      if (lastError.response) {
        console.error("Audio upload failed:", lastError.response.status, lastError.response.data);
      } else {
        console.error("Audio upload failed:", lastError.message);
      }
    }
    return res.status(500).json({ error: "Audio upload failed. Please try again later." });
  }

  // For Open Cloud, poll for operation status to get assetId
  let assetId = null;
  if (useOpenCloud && responseData.path) {
    const operationPath = responseData.path;
    try {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const opResponse = await axios.get(`https://apis.roblox.com/assets/v1/${operationPath}`, {
          headers: { 'x-api-key': ROBLOX_API_KEY }
        });
        const opData = opResponse.data;
        if (opData && opData.done) {
          if (opData.response && opData.response.assetId) {
            assetId = opData.response.assetId;
          } else if (opData.error) {
            const errMsg = opData.error.message || "unknown error";
            throw new Error(`Asset upload failed: ${errMsg}`);
          }
          break;
        }
      }
    } catch (err) {
      console.error("Error checking operation status:", err.response ? err.response.data : err.message);
      return res.status(500).json({ error: "Upload operation failed or timed out." });
    }
    if (!assetId) {
      console.error("Asset creation not completed within expected time.");
      return res.status(500).json({ error: "Asset processing not completed. Please try again later." });
    }
  } else if (!useOpenCloud) {
    // Legacy response parsing
    if (responseData.assetId) {
      assetId = responseData.assetId;
    } else if (responseData.Id) {
      assetId = responseData.Id;
    }
    if (!assetId) {
      console.error("Failed to retrieve asset ID from legacy upload response.");
      return res.status(500).json({ error: "Failed to retrieve asset ID from Roblox." });
    }
  }

  console.log(`Upload successful. Asset ID: ${assetId}`);
  return res.status(200).json({ robloxAssetId: assetId });
});

// (Optional) Serve static files from the audio directory if needed
app.use('/audio', express.static(AUDIO_DIR));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`TTS server listening on port ${PORT}`);
});
