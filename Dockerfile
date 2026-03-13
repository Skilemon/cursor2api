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

# 设置工作目录
WORKDIR /app

# 仅拷贝包配置并安装所有依赖项（利用 Docker 缓存层）
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝项目源代码并执行 TypeScript 编译
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ==== Stage 2: 生产运行阶段 (Runner) ====
FROM node:22-alpine AS runner

WORKDIR /app

# 设置为生产环境
ENV NODE_ENV=production

# 安装运行时依赖（mihomo 需要）
RUN apk add --no-cache ca-certificates tzdata

# 拷贝 mihomo 二进制并设置执行权限
COPY --from=mihomo-downloader /usr/local/bin/mihomo /usr/local/bin/mihomo
RUN chmod +x /usr/local/bin/mihomo

# 出于安全考虑，避免使用 root 用户运行服务
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 cursor

# 拷贝包配置并仅安装生产环境依赖（极大减小镜像体积）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# 从 builder 阶段拷贝编译后的产物
COPY --from=builder --chown=cursor:nodejs /app/dist ./dist

# 拷贝默认配置文件（可通过 volume 挂载覆盖）
COPY --chown=cursor:nodejs config.yaml ./config.yaml

# 切换到非 root 用户
USER cursor

# 声明对外暴露的端口
EXPOSE 3010

# 启动服务
CMD ["npm", "start"]
