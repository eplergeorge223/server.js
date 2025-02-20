FROM ubuntu:latest

# Install eSpeak for Linux
RUN apt-get update && apt-get install -y espeak

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
