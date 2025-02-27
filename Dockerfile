FROM node:18-slim

# Install espeak and ffmpeg
RUN apt-get update && \
    apt-get install -y espeak ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the source code
COPY . .

# Create the audio directory (used by your code) and set permissions
RUN mkdir -p audio && \
    chmod -R 777 audio

# Expose the port your app listens on
EXPOSE 3000

# Switch to non-root user
USER node

# Start the application
CMD ["node", "server.js"]
