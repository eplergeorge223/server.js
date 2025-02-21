local TTSModule = {}

-- Services
local SoundService = game:GetService("SoundService")
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

-- Constants
local SAMPLE_RATE = 44100
local BYTES_PER_SAMPLE = 2
local BUFFER_SIZE = 4096 -- Process audio in 4KB chunks

-- Create audio container
local AUDIO_CONTAINER = Instance.new("Folder")
AUDIO_CONTAINER.Name = "TTSAudioContainer"
AUDIO_CONTAINER.Parent = SoundService

-- State
local State = {
	activeSounds = {},
	isProcessing = false,
	queue = {},
}

-- Convert base64 string to binary data (table of numbers)
local function base64ToBinary(base64)
    local key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    local binary = {}
    
    base64 = string.gsub(base64, "[^" .. key .. "=]", "")
    
    local i = 1
    while i <= #base64 do
        local a = (string.find(key, string.sub(base64, i, i)) or 0) - 1
        local b = (string.find(key, string.sub(base64, i+1, i+1)) or 0) - 1
        local c = (string.find(key, string.sub(base64, i+2, i+2)) or 0) - 1
        local d = (string.find(key, string.sub(base64, i+3, i+3)) or 0) - 1
        
        local val = bit32.lshift(a, 18) + bit32.lshift(b, 12) + bit32.lshift(c, 6) + d
        
        table.insert(binary, bit32.extract(val, 16, 8))
        if c ~= -1 then table.insert(binary, bit32.extract(val, 8, 8)) end
        if d ~= -1 then table.insert(binary, bit32.extract(val, 0, 8)) end
        
        i = i + 4
    end
    
    return binary
end

-- Process PCM data: convert binary (16-bit samples) to normalized values (-1 to 1)
local function processPCMData(binaryData)
    local samples = {}
    
    for i = 1, #binaryData, 2 do
        local low = binaryData[i]
        local high = binaryData[i+1] or 0
        
        local sample = bit32.bor(bit32.lshift(high, 8), low)
        if sample > 32767 then sample = sample - 65536 end
        
        table.insert(samples, sample / 32768)
    end
    
    return samples
end

-- Create and play the sound from the base64 audio data
local function createSound(audioData, position, player)
    local sound = Instance.new("Sound")
    sound.Volume = 0.8
    sound.RollOffMode = Enum.RollOffMode.Linear
    sound.RollOffMaxDistance = 100

    -- Determine where to parent the sound
    local container
    if position then
        container = Instance.new("Attachment")
        container.WorldPosition = position
        container.Parent = workspace.Terrain
    elseif player and player.Character and player.Character:FindFirstChild("Head") then
        container = player.Character.Head
    else
        container = AUDIO_CONTAINER
    end
    sound.Parent = container

    -- Decode and process the audio data
    local binaryData = base64ToBinary(audioData)
    local samples = processPCMData(binaryData)
    
    local bufferSize = BUFFER_SIZE
    local currentIndex = 1
    local connection
    connection = RunService.Heartbeat:Connect(function()
        if currentIndex > #samples then
            connection:Disconnect()
            sound:Destroy()
            return
        end
        
        local chunk = {}
        for i = 1, bufferSize do
            if currentIndex + i - 1 <= #samples then
                chunk[i] = samples[currentIndex + i - 1]
            else
                break
            end
        end
        
        if #chunk > 0 then
            sound:PlayBuffer(chunk)
            currentIndex = currentIndex + #chunk
        end
    end)
    
    return sound
end

-- The speak function sends the text to the TTS server and plays the audio when received.
function TTSModule.speak(text, position, player)
    if not player then error("Player is required") end

    if State.isProcessing then
        table.insert(State.queue, { text = text, position = position, player = player })
        return
    end

    State.isProcessing = true

    local success, response = pcall(function()
        return HttpService:PostAsync(
            "https://your-production-url/api/tts", -- Replace with your actual URL
            HttpService:JSONEncode({ text = text, voice = "en", speed = 175 }),
            Enum.HttpContentType.ApplicationJson
        )
    end)

    if success then
        local data = HttpService:JSONDecode(response)
        if data.audio_data then
            local sound = createSound(data.audio_data, position, player)
            if sound then
                table.insert(State.activeSounds, sound)
            end
        else
            warn("No audio_data returned from TTS API.")
        end
    else
        warn("TTS request failed:", response)
    end

    State.isProcessing = false

    if #State.queue > 0 then
        local nextRequest = table.remove(State.queue, 1)
        TTSModule.speak(nextRequest.text, nextRequest.position, nextRequest.player)
    end
end

-- Stop all currently playing TTS sounds
function TTSModule.stop(player)
    for i = #State.activeSounds, 1, -1 do
        local sound = State.activeSounds[i]
        if sound and sound.Parent then
            sound:Stop()
            sound:Destroy()
            table.remove(State.activeSounds, i)
        end
    end
end

function TTSModule.init()
    TTSModule.stop()
    return true
end

return TTSModule
