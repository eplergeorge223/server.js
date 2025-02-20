FROM node:18-slim

# Install espeak
RUN apt-get update && \
    apt-get install -y espeak && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Create output directory
RUN mkdir -p tts_wav_output

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
