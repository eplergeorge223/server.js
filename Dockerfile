# Example Dockerfile using Node 18 LTS
FROM node:18

# Install eSpeak (if needed)
RUN apt-get update && apt-get install -y espeak

WORKDIR /app

# Copy package.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your server code
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
