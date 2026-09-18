FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# HF Spaces Docker SDK: app must listen on this port (README app_port)
EXPOSE 7860

CMD ["node", "src/index.js"]
