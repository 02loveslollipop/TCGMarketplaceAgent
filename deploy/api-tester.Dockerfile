FROM node:24-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN VITE_AUTH_URL= VITE_CHAT_API_URL= VITE_ADMIN_API_URL= VITE_API_TEST_BOOTSTRAP=true npm run build

FROM node:24-alpine AS api-tester
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/dist/api-test ./public/api-test
COPY --from=build /app/dist/assets ./public/assets
COPY deploy/api-tester-server.mjs ./server.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
