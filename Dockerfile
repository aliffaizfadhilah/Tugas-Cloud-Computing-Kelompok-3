FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
