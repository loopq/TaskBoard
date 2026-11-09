FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data WEB_DIST=/app/web/dist NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --chown=1000:1000 api/package.json api/schema.sql ./api/
COPY --chown=1000:1000 api/src ./api/src
COPY --chown=1000:1000 web/dist ./web/dist
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "api/src/server.ts"]
