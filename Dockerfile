# Multi-Arch: läuft auf Raspi (arm64/arm/v7) und Unraid (amd64)
FROM node:20-alpine

# Leichtes Image – keine ADB/Android-Tools mehr nötig

WORKDIR /app

# Abhängigkeiten zuerst (Layer-Cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Quellcode kopieren
COPY server.js ./
COPY db.js ./
COPY public/ ./public/

# data/ wird als Volume gemountet → Einstellungen bleiben erhalten
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
