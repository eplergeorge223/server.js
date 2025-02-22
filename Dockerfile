FROM node:18-slim

# Install espeak and ffmpeg
RUN apt-get update && \
    apt-get install -y espeak ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install
RUN npm install express node-fetch

# Copy source code
COPY . .

# Create output directory and set permissions (update to match your code's directory)
RUN mkdir -p tts_output && \
    chmod 777 tts_output && \
    chown -R node:node .

# Expose the port the app runs on
EXPOSE 3000

# Switch to non-root user
USER node

# Start the application
CMD ["node", "server.js"]
