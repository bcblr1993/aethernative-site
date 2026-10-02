# 推送服务：Node 直接运行 TypeScript（类型擦除），没有第三方依赖，也没有编译步骤。
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER node
ENTRYPOINT ["node"]
# P0 阶段只有测试脚本；P2 加入常驻服务后改为 src/main.ts
CMD ["scripts/send-test.ts", "--help"]
