FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3011

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/api ./api
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/start-prod.js ./scripts/start-prod.js

USER node

EXPOSE 3011

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=10 CMD ["node", "-e", "const port=process.env.PORT||3011;fetch('http://127.0.0.1:'+port+'/api/health').then((res)=>process.exit(res.ok?0:1)).catch(()=>process.exit(1));"]

CMD ["node", "scripts/start-prod.js"]