# ==== Stage 0: 打包 mihomo 二进制 ====
# 请提前将对应平台的 mihomo 二进制放到 bin/ 目录：
#   bin/mihomo-amd64  （Linux x86_64）
#   bin/mihomo-arm64  （Linux ARM64）
FROM alpine:3.19 AS mihomo-downloader

ARG TARGETARCH=amd64
COPY bin/mihomo-${TARGETARCH} /usr/local/bin/mihomo
RUN chmod +x /usr/local/bin/mihomo

# ==== Stage 1: 构建阶段 (Builder) ====
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ==== Stage 2: 生产运行阶段 (Runner) ====
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# 增大 Node.js 堆内存上限（tesseract.js / js-tiktoken 初始化有一定内存需求）
ENV NODE_OPTIONS="--max-old-space-size=4096"

# 安装运行时依赖（mihomo 需要 ca-certificates）
RUN apk add --no-cache ca-certificates tzdata

# 拷贝 mihomo 二进制
COPY --from=mihomo-downloader /usr/local/bin/mihomo /usr/local/bin/mihomo
RUN chmod +x /usr/local/bin/mihomo

# 非 root 用户
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 cursor

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --from=builder --chown=cursor:nodejs /app/dist ./dist
COPY --chown=cursor:nodejs public ./public

RUN mkdir -p /app/logs && chown cursor:nodejs /app/logs

USER cursor

EXPOSE 3010
VOLUME ["/app/logs"]

CMD ["npm", "start"]
