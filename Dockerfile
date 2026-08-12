# Multi-Arch: läuft auf Raspi (arm64/arm/v7) und Unraid (amd64)
FROM node:20-alpine

# Leichtes Image – keine ADB/Android-Tools mehr nötig

WORKDIR /app

# Abhängigkeiten zuerst (Layer-Cache)
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps \
			python3 \
			make \
			g++ \
		&& npm ci --omit=dev \
		&& apk del .build-deps

# Quellcode kopieren
# Wichtig: Der Build-Kontext ist das App-Verzeichnis selbst; deshalb alle Projektdateien mitkopieren,
# nicht nur einzelne Dateien. Sonst fehlen Modulordner wie lib/, modes/ oder scripts/ im Container.
COPY . .

# data/ wird als Volume gemountet → Einstellungen bleiben erhalten
RUN mkdir -p /app/data

EXPOSE 3100 3200

ENV NODE_ENV=production

CMD ["node", "server.js"]
