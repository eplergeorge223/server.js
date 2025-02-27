const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { promisify } = require('util');
const fsPromises = fs.promises;

// Use environment variables for configuration
// Uncomment to use dotenv if needed
// require('dotenv').config();

const app = express();
app.use(express.json());

// API Configuration
const config = {
  ROBLOX_API_KEY: process.env.ROBLOX_API_KEY || "",
  ROBLOX_SECURITY_COOKIE: process.env.ROBLOX_SECURITY || "",
  CREATOR_TYPE: process.env.CREATOR_TYPE || "User",
  CREATOR_ID: process.env.CREATOR_ID || "",
  MAX_RETRIES: Number(process.env.MAX_RETRIES) || 5,
  BASE_RETRY_DELAY: Number(process.env.BASE_RETRY_DELAY) || 500,
  PORT: process.env.PORT || 3000,
  OPERATION_POLLING_INTERVAL: Number(process.env.OPERATION_POLLING_INTERVAL) || 1000,
  MAX_OPERATION_POLLING_ATTEMPTS: Number(process.env.MAX_OPERATION_POLLING_ATTEMPTS) || 20
};

// Set up cache and audio storage
const AUDIO_DIR = path.join(process.cwd(), 'audio');
const CACHE = new Map(); // In-memory cache for quick lookups

// Create audio directory if it doesn't exist
(async () => {
  try {
    await fsPromises.mkdir(AUDIO_DIR, { recursive: true });
    console.log('Audio directory ready:', AUDIO_DIR);
  } catch (err) {
    console.error('Failed to create audio directory:', err);
    process.exit(1);
  }
})();

/**
 * Executes a shell command as a Promise
 */
function executeCommand(command, args, errorMessage) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let stderr = '';
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${errorMessage} (${code}): ${stderr}`));
      }
    });
  });
}

/**
 * Generates a TTS audio file using eSpeak
 */
async function runEspeak(text, voice, speed, outputPath) {
  return executeCommand(
    'espeak',
    ['-v', voice, '-s', speed.toString(), text, '-w', outputPath],
    'eSpeak failed'
  );
}

/**
 * Converts WAV to MP3 using FFmpeg
 */
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

/**
 * Get audio file duration using FFprobe
 */
async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    
    let output = '';
    let errorOutput = '';
    
    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobe.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ffprobe.on('close', (code) => {
      if (code === 0) {
        resolve(parseFloat(output.trim()));
      } else {
        resolve(0); // Default to 0 on error
      }
    });
  });
}

/**
 * Generates MP3 audio from text with caching support
 */
async function generateTTSAudio(text, voice = "en", speed = 175) {
  // Create a unique hash for cache key
  const hash = crypto.createHash('md5').update(`${text}${voice}${speed}`).digest('hex');
  const wavFile = path.join(AUDIO_DIR, `${hash}.wav`);
  const mp3File = path.join(AUDIO_DIR, `${hash}.mp3`);
  
  // Check memory cache first
  if (CACHE.has(hash)) {
    return CACHE.get(hash);
  }
  
  // Check disk cache
  try {
    const exists = await fsPromises.access(mp3File)
      .then(() => true)
      .catch(() => false);

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
  } catch (err) {
    console.warn('Cache check error:', err.message);
  }

  // Generate new audio
  try {
    // Run espeak to generate WAV
    await runEspeak(text, voice, speed, wavFile);
    
    // Convert WAV to MP3
    await convertToMp3(wavFile, mp3File);
    
    // Get file stats and audio duration
    const stats = await fsPromises.stat(mp3File);
    const duration = await getAudioDuration(mp3File);
    
    // Clean up temp WAV file
    await fsPromises.unlink(wavFile).catch(err => console.warn('WAV cleanup error:', err.message));
    
    // Cache result and return
    const result = { 
      audioFilePath: mp3File, 
      audioId: hash,
      duration,
      fileSize: stats.size 
    };
    CACHE.set(hash, result);
    return result;
  } catch (err) {
    // Clean up partial files on error
    await fsPromises.unlink(wavFile).catch(() => {});
    await fsPromises.unlink(mp3File).catch(() => {});
    throw err;
  }
}

/**
 * Uploads an audio file to Roblox
 */
async function uploadToRoblox(audioFile, audioId) {
  if (!config.CREATOR_ID) {
    throw new Error("CREATOR_ID is not configured");
  }

  const useOpenCloud = !!config.ROBLOX_API_KEY;
  const assetName = `TTS Audio ${audioId.substring(0, 8)}`;
  
  // Create form data for upload
  const formData = new FormData();
  const requestPayload = {
    assetType: "Audio",
    creationContext: {
      creator: {}
    },
    description: "Text-to-Speech audio upload",
    displayName: assetName
  };
  
  // Set creator information
  if (config.CREATOR_TYPE.toLowerCase() === "group") {
    requestPayload.creationContext.creator.groupId = Number(config.CREATOR_ID);
  } else {
    requestPayload.creationContext.creator.userId = Number(config.CREATOR_ID);
  }
  
  // Add form data parts
  formData.append('request', JSON.stringify(requestPayload), { contentType: 'application/json' });
  formData.append('fileContent', fs.createReadStream(audioFile), "ttsAudio.mp3");
  
  // Set headers based on authentication method
  const headers = { ...formData.getHeaders() };
  if (useOpenCloud) {
    headers['x-api-key'] = config.ROBLOX_API_KEY;
  } else if (config.ROBLOX_SECURITY_COOKIE) {
    headers['Cookie'] = `.ROBLOSECURITY=${config.ROBLOX_SECURITY_COOKIE}`;
  }

  const uploadUrl = useOpenCloud 
    ? "https://apis.roblox.com/assets/v1/assets"
    : "https://www.roblox.com/asset/request-upload";

  // Upload with retry logic
  let responseData;
  let lastError;
  
  for (let attempt = 1; attempt <= config.MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(uploadUrl, formData, { headers });
      responseData = response.data;
      break;
    } catch (err) {
      // Handle CSRF token for cookie auth
      if (!useOpenCloud && err.response && err.response.status === 403) {
        const csrfToken = err.response.headers['x-csrf-token'];
        if (csrfToken) {
          headers['X-CSRF-TOKEN'] = csrfToken;
          console.log("Received CSRF token, retrying upload");
          continue;
        }
      }
      
      lastError = err;
      
      // Determine if we should retry
      if (attempt < config.MAX_RETRIES) {
        const status = err.response ? err.response.status : null;
        if (!err.response || status === 429 || status >= 500) {
          const delay = Math.pow(2, attempt) * config.BASE_RETRY_DELAY;
          console.log(`Upload attempt ${attempt} failed (${status || 'network error'}). Retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      break;
    }
  }

  if (!responseData) {
    if (lastError?.response) {
      throw new Error(`Upload failed: ${lastError.response.status} - ${JSON.stringify(lastError.response.data)}`);
    } else if (lastError) {
      throw new Error(`Upload failed: ${lastError.message}`);
    } else {
      throw new Error("Upload failed with unknown error");
    }
  }

  // Handle asset ID retrieval
  let assetId = null;
  
  if (useOpenCloud && responseData.path) {
    // For Open Cloud API, poll operation status
    const operationPath = responseData.path;
    
    for (let i = 0; i < config.MAX_OPERATION_POLLING_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, config.OPERATION_POLLING_INTERVAL));
      
      const opResponse = await axios.get(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { 'x-api-key': config.ROBLOX_API_KEY }
      });
      
      const opData = opResponse.data;
      console.log(`Operation status (attempt ${i + 1}):`, opData.status || opData.done || 'pending');
      
      if (opData && opData.done) {
        if (opData.response && opData.response.assetId) {
          assetId = opData.response.assetId;
        } else if (opData.error) {
          throw new Error(`Asset upload failed: ${opData.error.message || "unknown error"}`);
        }
        break;
      }
    }
    
    if (!assetId) {
      throw new Error("Asset processing not completed. Please try again later.");
    }
  } else if (!useOpenCloud) {
    // For legacy API, extract asset ID directly
    assetId = responseData.assetId || responseData.Id;
    
    if (!assetId) {
      throw new Error("Failed to retrieve asset ID from upload response");
    }
  }

  return assetId;
}

// API ENDPOINTS

/**
 * TTS Generation Endpoint
 * POST /api/tts
 */
app.post('/api/tts', async (req, res) => {
  const { text, voice = "en", speed = 175 } = req.body;
  
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "No text provided for TTS" });
  }

  try {
    const { audioFilePath, audioId, duration, fileSize } = await generateTTSAudio(text, voice, speed);
    
    // Build URL for static access
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    const url = `${protocol}://${host}/audio/${audioId}.mp3`;

    return res.status(200).json({
      audio_id: audioId,
      duration: duration || 1.0,
      file_size: fileSize,
      url: url
    });
  } catch (err) {
    console.error("TTS generation failed:", err);
    return res.status(500).json({ error: `TTS generation failed: ${err.message}` });
  }
});

/**
 * Roblox Upload Endpoint
 * POST /api/upload-to-roblox
 */
app.post('/api/upload-to-roblox', async (req, res) => {
  const { audioId } = req.body;
  
  if (!audioId) {
    return res.status(400).json({ error: "Missing audioId" });
  }

  const mp3File = path.join(AUDIO_DIR, `${audioId}.mp3`);
  
  try {
    const exists = await fsPromises.access(mp3File)
      .then(() => true)
      .catch(() => false);
      
    if (!exists) {
      return res.status(404).json({ error: "Audio file not found" });
    }
    
    const assetId = await uploadToRoblox(mp3File, audioId);
    
    console.log(`Upload successful. Asset ID: ${assetId}`);
    return res.status(200).json({ robloxAssetId: assetId });
  } catch (err) {
    console.error("Roblox upload failed:", err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Health check endpoint
 * GET /health
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', version: '1.1.0' });
});

// Serve static files
app.use('/audio', express.static(AUDIO_DIR, {
  maxAge: '1d',
  immutable: true
}));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(config.PORT, () => {
  console.log(`TTS server listening on port ${config.PORT}`);
  console.log(`Using authentication: ${config.ROBLOX_API_KEY ? 'API Key' : (config.ROBLOX_SECURITY_COOKIE ? 'Cookie' : 'None')}`);
  console.log(`Creator: ${config.CREATOR_TYPE} ID ${config.CREATOR_ID || 'not set'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
