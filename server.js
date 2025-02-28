/********************************************************
 * server.js
 * 
 * An Express server that:
 * 1) Generates TTS MP3 via eSpeak (Node side).
 * 2) Uploads to Roblox as a group-owned asset.
 * 3) Caches approved asset IDs for common dialogue lines.
 * 4) Provides endpoints for on-demand generation, batch
 *    pre-generation, and asset lookup.
 ********************************************************/

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fsPromises = fs.promises;

const app = express();
app.use(express.json());

//--------------- ENV CONFIG ---------------
const config = {
  // If using Open Cloud, put your API key here:
  ROBLOX_API_KEY: process.env.ROBLOX_API_KEY || "",
  // If using Cookie-based auth:
  ROBLOX_SECURITY_COOKIE: process.env.ROBLOX_SECURITY || "",
  // "User" or "Group"
  CREATOR_TYPE: process.env.CREATOR_TYPE || "Group",
  // Numeric ID of user or group
  CREATOR_ID: process.env.CREATOR_ID || "",
  MAX_RETRIES: Number(process.env.MAX_RETRIES) || 5,
  // Increased default retry delay to 1000ms to help avoid rate limits
  BASE_RETRY_DELAY: Number(process.env.BASE_RETRY_DELAY) || 1000,
  PORT: process.env.PORT || 3000,
  // For Open Cloud polling
  OPERATION_POLLING_INTERVAL: Number(process.env.OPERATION_POLLING_INTERVAL) || 1000,
  MAX_OPERATION_POLLING_ATTEMPTS: Number(process.env.MAX_OPERATION_POLLING_ATTEMPTS) || 20
};

//-------------- AUDIO STORAGE & CACHE --------------
const AUDIO_DIR = path.join(process.cwd(), 'audio');
const CACHE = new Map(); // In-memory cache (key: hash, value: { audioFilePath, audioId, duration, fileSize })

// Persistent cache file path for pre-generated dialogues
const CACHE_FILE = path.join(process.cwd(), 'cache.json');
let persistentCache = new Map();

// Load persistent cache from file
async function loadPersistentCache() {
  try {
    const data = await fsPromises.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    for (const key in parsed) {
      persistentCache.set(key, parsed[key]);
    }
    console.log('[TTS] Persistent cache loaded.');
  } catch (err) {
    console.warn('[TTS] No persistent cache found. Starting fresh.');
  }
}

// Save persistent cache to file
async function savePersistentCache() {
  try {
    const obj = Object.fromEntries(persistentCache);
    await fsPromises.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    console.log('[TTS] Persistent cache saved.');
  } catch (err) {
    console.error('[TTS] Error saving persistent cache:', err);
  }
}

(async () => {
  // Ensure audio directory exists
  try {
    await fsPromises.mkdir(AUDIO_DIR, { recursive: true });
    console.log('[TTS] Audio directory ready:', AUDIO_DIR);
  } catch (err) {
    console.error('[TTS] Failed to create audio directory:', err);
    process.exit(1);
  }
  await loadPersistentCache();
})();

/*******************************************************
 * Exec Helpers (spawn child processes, eSpeak, ffmpeg)
 *******************************************************/
function executeCommand(command, args, errorMessage) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${errorMessage} (${code}): ${stderr}`));
      }
    });
  });
}

/** eSpeak: generate WAV via command-line */
async function runEspeak(text, voice, speed, outputPath) {
  // Example: espeak -v en -s 175 "Hello world" -w output.wav
  return executeCommand(
    'espeak',
    ['-v', voice, '-s', speed.toString(), text, '-w', outputPath],
    'eSpeak failed'
  );
}

/** Convert WAV -> MP3 using ffmpeg */
async function convertToMp3(inputPath, outputPath) {
  return executeCommand(
    'ffmpeg',
    [
      '-i', inputPath,
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-ar', '44100',
      '-y',
      outputPath
    ],
    'FFmpeg conversion failed'
  );
}

/** Get audio file duration with ffprobe */
async function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    
    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.stderr.on('data', () => {
      // ignoring ffprobe errors
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        resolve(parseFloat(output.trim()) || 0);
      } else {
        resolve(0);
      }
    });
  });
}

/*******************************************************
 * generateTTSAudio:
 * 1) Check memory/disk cache.
 * 2) Run eSpeak to produce WAV.
 * 3) Convert WAV -> MP3.
 * 4) Return local file path + metadata.
 *******************************************************/
async function generateTTSAudio(text, voice = "en", speed = 175) {
  // Create unique hash (text+voice+speed)
  const hash = crypto.createHash('md5').update(`${text}${voice}${speed}`).digest('hex');
  const wavFile = path.join(AUDIO_DIR, `${hash}.wav`);
  const mp3File = path.join(AUDIO_DIR, `${hash}.mp3`);

  // 1) Check memory cache
  if (CACHE.has(hash)) {
    return CACHE.get(hash);
  }

  // 2) Check disk for existing mp3
  let exists = false;
  try {
    await fsPromises.access(mp3File);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) {
    const stats = await fsPromises.stat(mp3File);
    const duration = await getAudioDuration(mp3File);
    const result = {
      audioFilePath: mp3File,
      audioId: hash,
      duration,
      fileSize: stats.size
    };
    CACHE.set(hash, result);
    return result;
  }

  // 3) Not in cache, generate new audio
  try {
    await runEspeak(text, voice, speed, wavFile);
    await convertToMp3(wavFile, mp3File);

    const stats = await fsPromises.stat(mp3File);
    const duration = await getAudioDuration(mp3File);

    // Cleanup WAV file
    await fsPromises.unlink(wavFile).catch((err) => {
      console.warn('[TTS] WAV cleanup error:', err.message);
    });

    const result = {
      audioFilePath: mp3File,
      audioId: hash,
      duration,
      fileSize: stats.size
    };
    CACHE.set(hash, result);
    return result;
  } catch (err) {
    await fsPromises.unlink(wavFile).catch(() => {});
    await fsPromises.unlink(mp3File).catch(() => {});
    throw err;
  }
}

/*******************************************************
 * uploadToRoblox:
 * 1) Use Open Cloud API (if ROBLOX_API_KEY is set) or cookie-based auth.
 * 2) Upload the audio file and return the new assetId.
 *******************************************************/
async function uploadToRoblox(audioFile, audioId) {
  if (!config.CREATOR_ID) {
    throw new Error("[TTS] CREATOR_ID is not configured");
  }

  const useOpenCloud = !!config.ROBLOX_API_KEY;
  const assetName = `TTS Audio ${audioId.substring(0, 8)}`;

  const formData = new FormData();
  const requestPayload = {
    assetType: "Audio",
    creationContext: { creator: {} },
    description: "Text-to-Speech audio upload",
    displayName: assetName
  };

  if (config.CREATOR_TYPE.toLowerCase() === "group") {
    requestPayload.creationContext.creator.groupId = Number(config.CREATOR_ID);
  } else {
    requestPayload.creationContext.creator.userId = Number(config.CREATOR_ID);
  }

  formData.append('request', JSON.stringify(requestPayload), { contentType: 'application/json' });
  formData.append('fileContent', fs.createReadStream(audioFile), "ttsAudio.mp3");

  const headers = { ...formData.getHeaders() };
  if (useOpenCloud) {
    headers['x-api-key'] = config.ROBLOX_API_KEY;
  } else if (config.ROBLOX_SECURITY_COOKIE) {
    headers['Cookie'] = `.ROBLOSECURITY=${config.ROBLOX_SECURITY_COOKIE}`;
  }

  const uploadUrl = useOpenCloud
    ? "https://apis.roblox.com/assets/v1/assets"
    : "https://www.roblox.com/asset/request-upload";

  let responseData;
  let lastError;

  for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(uploadUrl, formData, { headers });
      responseData = response.data;
      break; // success
    } catch (err) {
      // Handle CSRF token if needed (legacy method)
      if (!useOpenCloud && err.response && err.response.status === 403) {
        const csrfToken = err.response.headers['x-csrf-token'];
        if (csrfToken) {
          headers['X-CSRF-TOKEN'] = csrfToken;
          console.log("[TTS] Received CSRF token, retrying upload");
          continue;
        }
      }
      lastError = err;
      if (attempt < config.MAX_RETRIES) {
        const status = err.response ? err.response.status : null;
        if (!err.response || status === 429 || status >= 500) {
          const delay = Math.pow(2, attempt) * config.BASE_RETRY_DELAY;
          console.log(`[TTS] Upload attempt ${attempt} failed (${status || 'network'}). Retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      break;
    }
  }

  if (!responseData) {
    if (lastError?.response) {
      throw new Error(`[TTS] Upload failed: ${lastError.response.status} - ${JSON.stringify(lastError.response.data)}`);
    } else if (lastError) {
      throw new Error(`[TTS] Upload failed: ${lastError.message}`);
    } else {
      throw new Error("[TTS] Upload failed with unknown error");
    }
  }

  let assetId = null;
  if (useOpenCloud && responseData.path) {
    const operationPath = responseData.path;
    for (let i = 0; i < config.MAX_OPERATION_POLLING_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, config.OPERATION_POLLING_INTERVAL));
      const opResponse = await axios.get(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { 'x-api-key': config.ROBLOX_API_KEY }
      });
      const opData = opResponse.data;
      console.log(`[TTS] Operation status (attempt ${i+1}):`, opData.status || opData.done || 'pending');

      if (opData && opData.done) {
        if (opData.response && opData.response.assetId) {
          assetId = opData.response.assetId;
        } else if (opData.error) {
          throw new Error(`[TTS] Asset upload failed: ${opData.error.message || "unknown"}`);
        }
        break;
      }
    }
    if (!assetId) {
      throw new Error("[TTS] Asset processing not completed. Try again later.");
    }
  } else if (!useOpenCloud) {
    assetId = responseData.assetId || responseData.Id;
    if (!assetId) {
      throw new Error("[TTS] Failed to retrieve asset ID from response");
    }
  }
  return assetId;
}

/*******************************************************
 * EXPRESS ROUTES
 *******************************************************/

// 1) On-Demand TTS Generation (for testing or fallback)
app.post('/api/tts', async (req, res) => {
  const { text, voice = "en", speed = 175 } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided for TTS" });
  }
  try {
    const { audioFilePath, audioId, duration, fileSize } = await generateTTSAudio(text, voice, speed);
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}/audio/${audioId}.mp3`;
    return res.status(200).json({
      audio_id: audioId,
      duration: duration || 1.0,
      file_size: fileSize,
      url
    });
  } catch (err) {
    console.error("[TTS] TTS generation failed:", err);
    return res.status(500).json({ error: `TTS generation failed: ${err.message}` });
  }
});

// 2) Roblox Upload (on demand)
app.post('/api/upload-to-roblox', async (req, res) => {
  const { audioId } = req.body;
  if (!audioId) {
    return res.status(400).json({ error: "Missing audioId" });
  }
  const mp3File = path.join(AUDIO_DIR, `${audioId}.mp3`);
  try {
    await fsPromises.access(mp3File);
  } catch {
    return res.status(404).json({ error: "Audio file not found" });
  }
  try {
    const assetId = await uploadToRoblox(mp3File, audioId);
    console.log(`[TTS] Upload successful. Asset ID: ${assetId}`);
    return res.status(200).json({ robloxAssetId: assetId });
  } catch (err) {
    console.error("[TTS] Roblox upload failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

// 3) Batch Pre-Generation Endpoint
// Expects JSON body: { dialogues: [ "Hello world", "How are you?", ... ] }
app.post('/api/pregenerate', async (req, res) => {
  const dialogues = req.body.dialogues;
  if (!Array.isArray(dialogues) || dialogues.length === 0) {
    return res.status(400).json({ error: "No dialogues provided" });
  }
  
  const results = {};
  for (const text of dialogues) {
    try {
      const { audioFilePath, audioId } = await generateTTSAudio(text);
      // Check persistent cache first
      let entry = persistentCache.get(audioId);
      if (!entry || !entry.assetId) {
        // Upload and cache the result
        const assetId = await uploadToRoblox(audioFilePath, audioId);
        entry = { text, assetId, status: "approved", timestamp: Date.now() };
        persistentCache.set(audioId, entry);
        await savePersistentCache();
      }
      results[text] = { assetId: entry.assetId, status: entry.status };
    } catch (err) {
      console.error(`[TTS] Error processing dialogue "${text}":`, err);
      results[text] = { error: err.message, status: "failed" };
    }
    // Wait 3 seconds between dialogues to reduce rate-limit issues
    await new Promise(r => setTimeout(r, 3000));
  }
  res.json(results);
});

// 4) Lookup Endpoint: Returns asset info for a given dialogue text.
// Usage: GET /api/lookup?text=Hello%20world
app.get('/api/lookup', async (req, res) => {
  const text = req.query.text;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "No text provided" });
  }
  const hash = crypto.createHash('md5').update(text).digest('hex');
  const data = persistentCache.get(hash);
  if (data && data.assetId && data.status === "approved") {
    return res.json({ assetId: data.assetId, status: data.status });
  }
  return res.json({ status: "pending", message: "Audio will be available later" });
});

// 5) Health Check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', version: '1.1.0' });
});

// 6) Serve static MP3 files (for debug/testing)
app.use('/audio', express.static(AUDIO_DIR, {
  maxAge: '1d',
  immutable: true
}));

/*******************************************************
 * ERROR HANDLER
 *******************************************************/
app.use((err, req, res, next) => {
  console.error('[TTS] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

/*******************************************************
 * START SERVER
 *******************************************************/
app.listen(config.PORT, () => {
  console.log(`[TTS] Server listening on port ${config.PORT}`);
  if (config.ROBLOX_API_KEY) {
    console.log(`[TTS] Using Open Cloud API Key auth`);
  } else if (config.ROBLOX_SECURITY_COOKIE) {
    console.log(`[TTS] Using .ROBLOSECURITY cookie auth`);
  } else {
    console.warn('[TTS] No authentication method set for uploading to Roblox');
  }
  console.log(`[TTS] Creator: ${config.CREATOR_TYPE} ID ${config.CREATOR_ID || 'not set'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[TTS] SIGTERM received, shutting down gracefully');
  process.exit(0);
});
