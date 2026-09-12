FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Auth state is a mounted volume: baking it into an image would ship a live
# WhatsApp session credential.
VOLUME ["/app/auth_state"]
CMD ["node", "dist/index.js"]
