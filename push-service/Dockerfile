# 推送服务：Node 直接运行 TypeScript（类型擦除），没有第三方依赖，也没有编译步骤。
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# node:sqlite 在 Node 24 仍标记为实验特性，关闭对应的启动警告
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 CMD ["node", "scripts/healthcheck.ts"]
ENTRYPOINT ["node"]
CMD ["src/main.ts"]
