# MCP de Beebole — imagen para el modo HTTP remoto (VPS / Coolify).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV PORT=8087
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 8087
# Arranca en modo HTTP stateless. El token de cada cliente viaja por cabecera X-Beebole-Key.
CMD ["node", "dist/index.js"]
