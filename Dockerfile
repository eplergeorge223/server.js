# Dockerfile
FROM ubuntu:latest

# Install eSpeak
RUN apt-get update && apt-get install -y espeak

# Install Node.js
RUN apt-get install -y curl
RUN curl -fsSL https://deb.nodesource.com/setup_14.x | bash -
RUN apt-get install -y nodejs

WORKDIR /app

# Copy files
COPY package*.json ./
RUN npm install

COPY . .

# Expose port 3000
EXPOSE 3000

CMD ["node", "server.js"]
