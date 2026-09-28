FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server.mjs package.json ./
COPY --chown=node:node dist/ ./dist/
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 BASE_PATH=/3D/monitor NODE_OPTIONS=--max-old-space-size=96
EXPOSE 4318
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
