FROM oven/bun:1.3.13-alpine
WORKDIR /app
COPY server.ts /app/server.ts
ENV PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "run", "/app/server.ts"]
