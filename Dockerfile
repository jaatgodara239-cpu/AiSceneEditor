FROM node:20-slim

# Install FFmpeg and FFprobe for audio duration detection & Ken Burns video rendering
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["npm", "start"]
