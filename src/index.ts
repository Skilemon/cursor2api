/**
 * Cursor2API - 入口
 *
 * 单容器多进程模式：
 * - 主进程：启动内置代理分配服务 + 用 cluster 派生 Worker
 * - Worker：各自独立持有一个代理IP，处理 HTTP 请求
 * - cluster 自动将请求轮询分发给各 Worker
 */

import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';
import { createRequire } from 'module';
import { getConfig } from './config.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

// 强制使用轮询调度（修复 Windows 下 cluster 不均衡问题）
cluster.schedulingPolicy = cluster.SCHED_RR;

if (cluster.isPrimary) {
    const config = getConfig();
    const workerCount = parseInt(process.env.WORKERS || '') || config.workers || os.cpus().length;
    const useAllocator = !!process.env.PROXY_POOL_URL;
    const useMihomo = !!(config.subscription || (config.nodes && config.nodes.length > 0));
    const proxyDisplay = useAllocator ? 'pool (allocator)' : useMihomo ? 'mihomo (per-node ports)' : (config.proxy || 'none');

    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log(`  ║        Cursor2API v${VERSION.padEnd(21)}║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  Port:    ${String(config.port).padEnd(27)}║`);
    console.log(`  ║  Workers: ${String(workerCount).padEnd(27)}║`);
    console.log(`  ║  Proxy:   ${proxyDisplay.padEnd(27)}║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    let actualWorkerCount = workerCount;

    // 如果配置了节点列表，启动多个 mihomo 进程（每个 Worker 独占一个）
    if (useMihomo) {
        const { startMihomo, getMihomoProxyUrls } = await import('./mihomo-manager.js');
        const instanceCount = await startMihomo(workerCount);
        if (instanceCount > 0) {
            const proxyUrls = getMihomoProxyUrls(instanceCount);
            process.env.PROXY_LIST = proxyUrls.join(',');
            actualWorkerCount = instanceCount;
        }
    }

    // 如果配置了代理池，启动内置分配服务
    if (useAllocator) {
        const { startAllocatorServer } = await import('./proxy-allocator.js');
        startAllocatorServer();
        // 通知 workers 使用内置分配服务
        process.env.PROXY_ALLOCATOR_URL = `http://127.0.0.1:${process.env.ALLOCATOR_PORT || '19999'}`;
    }

    // 派生 Workers
    const proxyList = process.env.PROXY_LIST ? process.env.PROXY_LIST.split(',') : [];
    for (let i = 0; i < actualWorkerCount; i++) {
        const env: Record<string, string> = { WORKER_INDEX: String(i) };
        if (proxyList.length > i) {
            env.PROXY = proxyList[i];
        }
        cluster.fork(env);
    }

    // Worker 退出自动重启
    cluster.on('exit', (worker, code, signal) => {
        console.error(`[Primary] Worker ${worker.process.pid} 退出 (code=${code}, signal=${signal})，正在重启...`);
        const idx = parseInt((worker.process as any).env?.WORKER_INDEX || '0');
        const env: Record<string, string> = { WORKER_INDEX: String(idx) };
        if (proxyList.length > idx) {
            env.PROXY = proxyList[idx];
        }
        // 延迟 1s 避免快速崩溃循环
        setTimeout(() => cluster.fork(env), 1000);
    });

    // 主进程退出时清理 mihomo
    const primaryCleanup = async () => {
        if (useMihomo) {
            const { stopMihomo } = await import('./mihomo-manager.js');
            await stopMihomo();
        }
        process.exit(0);
    };
    process.once('SIGTERM', primaryCleanup);
    process.once('SIGINT', primaryCleanup);

} else {
    // ==================== Worker 进程 ====================

    // ★ 给 Worker 的所有控制台输出加前缀，方便区分是哪个 Worker 打印的
    const wIdx = process.env.WORKER_INDEX ?? process.pid;
    const wPrefix = `[W${wIdx}] `;
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        const orig = console[method].bind(console);
        (console as any)[method] = (...args: unknown[]) => {
            const first = args[0];
            if (typeof first === 'string') {
                orig(wPrefix + first, ...args.slice(1));
            } else {
                orig(wPrefix, ...args);
            }
        };
    }

    // 初始化代理（每个 Worker 独立）
    const { initProxy } = await import('./proxy-agent.js');
    await initProxy();

    // 导入所有路由处理器
    const express = (await import('express')).default;
    const { getConfig: getConfigW, initConfigWatcher, stopConfigWatcher } = await import('./config.js');
    const { handleMessages, listModels, countTokens } = await import('./handler.js');
    const { handleOpenAIChatCompletions, handleOpenAIResponses } = await import('./openai-handler.js');
    const { serveLogViewer, apiGetLogs, apiGetRequests, apiGetStats, apiGetPayload, apiLogsStream, serveLogViewerLogin, apiClearLogs, serveVueApp, apiGetRequestsMore } = await import('./log-viewer.js');
    const { apiGetConfig, apiSaveConfig } = await import('./config-api.js');
    const { loadLogsFromFiles } = await import('./logger.js');
    const { initDb } = await import('./logger-db.js');

    const config = getConfigW();
    const app = express();

    // 解析 JSON body
    app.use(express.json({ limit: '50mb' }));

    // CORS
    app.use((_req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', '*');
        if (_req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });

    // 静态文件
    app.use('/public', express.static('public'));

    // 日志查看器鉴权中间件
    const logViewerAuth = (req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        const tokens = getConfigW().authTokens;
        if (!tokens || tokens.length === 0) return next();

        const tokenFromQuery = req.query.token as string | undefined;
        const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
        const tokenFromHeader = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '').trim() : undefined;
        const token = tokenFromQuery || tokenFromHeader;

        if (!token || !tokens.includes(token)) {
            if (req.path === '/logs') {
                return serveLogViewerLogin(req, res);
            }
            res.status(401).json({ error: { message: 'Unauthorized. Provide token via ?token=xxx or Authorization header.', type: 'auth_error' } });
            return;
        }
        next();
    };

    // 日志查看器路由
    app.get('/logs', logViewerAuth, serveLogViewer);
    app.get('/vuelogs', serveVueApp);
    app.get('/api/logs', logViewerAuth, apiGetLogs);
    app.get('/api/requests/more', logViewerAuth, apiGetRequestsMore);
    app.get('/api/requests', logViewerAuth, apiGetRequests);
    app.get('/api/stats', logViewerAuth, apiGetStats);
    app.get('/api/payload/:requestId', logViewerAuth, apiGetPayload);
    app.get('/api/logs/stream', logViewerAuth, apiLogsStream);
    app.post('/api/logs/clear', logViewerAuth, apiClearLogs);
    app.get('/api/config', logViewerAuth, apiGetConfig);
    app.post('/api/config', logViewerAuth, apiSaveConfig);

    // API 鉴权中间件
    app.use((req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => {
        if (req.method === 'GET' || req.path === '/health') {
            return next();
        }
        const tokens = getConfigW().authTokens;
        if (!tokens || tokens.length === 0) {
            return next();
        }
        const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
        if (!authHeader) {
            res.status(401).json({ error: { message: 'Missing authentication token. Use Authorization: Bearer <token>', type: 'auth_error' } });
            return;
        }
        const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
        if (!tokens.includes(token)) {
            console.log(`[Auth] 拒绝无效 token: ${token.substring(0, 8)}...`);
            res.status(403).json({ error: { message: 'Invalid authentication token', type: 'auth_error' } });
            return;
        }
        next();
    });

    // ==================== 路由 ====================

    app.post('/v1/messages', handleMessages);
    app.post('/messages', handleMessages);
    app.post('/v1/chat/completions', handleOpenAIChatCompletions);
    app.post('/chat/completions', handleOpenAIChatCompletions);
    app.post('/v1/responses', handleOpenAIResponses);
    app.post('/responses', handleOpenAIResponses);
    app.post('/v1/messages/count_tokens', countTokens);
    app.post('/messages/count_tokens', countTokens);
    app.get('/v1/models', listModels);
    app.get('/health', (_req, res) => res.json({ status: 'ok', version: VERSION, pid: process.pid }));
    app.get('/', (_req, res) => {
        res.json({
            name: 'cursor2api',
            version: VERSION,
            description: 'Cursor Docs AI → Anthropic & OpenAI & Cursor IDE API Proxy',
            endpoints: {
                anthropic_messages: 'POST /v1/messages',
                openai_chat: 'POST /v1/chat/completions',
                openai_responses: 'POST /v1/responses',
                models: 'GET /v1/models',
                health: 'GET /health',
                log_viewer: 'GET /logs',
                log_viewer_vue: 'GET /vuelogs',
            },
        });
    });

    // ==================== 启动 ====================

    // 初始化 SQLite（若启用）
    if (config.logging?.db_enabled) {
        initDb(config.logging.db_path || './logs/cursor2api.db');
    }

    // 从日志文件加载历史
    loadLogsFromFiles();

    app.listen(config.port, () => {
        const auth = config.authTokens?.length ? `${config.authTokens.length} token(s)` : 'open';
        const logParts: string[] = [];
        if (config.logging?.file_enabled) logParts.push(`file(${config.logging.persist_mode || 'summary'}) → ${config.logging.dir}`);
        if (config.logging?.db_enabled) logParts.push(`sqlite → ${config.logging.db_path}`);
        const logPersist = logParts.length ? logParts.join(', ') : 'memory only';

        let toolsInfo = 'default';
        const toolsCfg = config.tools;
        if (toolsCfg) {
            if (toolsCfg.disabled) {
                toolsInfo = 'DISABLED';
            } else {
                const parts: string[] = [toolsCfg.schemaMode || 'full'];
                if (toolsCfg.passthrough) parts.push('passthrough');
                if (toolsCfg.descriptionMaxLength) parts.push(`descMax=${toolsCfg.descriptionMaxLength}`);
                if (toolsCfg.includeOnly?.length) parts.push(`whitelist=${toolsCfg.includeOnly.length}`);
                if (toolsCfg.exclude?.length) parts.push(`blacklist=${toolsCfg.exclude.length}`);
                toolsInfo = parts.join(', ');
            }
        }

        console.log(`[Worker ${process.pid}] 已启动，监听 :${config.port} | Auth: ${auth} | Tools: ${toolsInfo} | Logging: ${logPersist}`);

        // 启动 config.yaml 热重载监听
        initConfigWatcher();
    });

    // 优雅关闭
    const { shutdownOcr } = await import('./vision.js');
    const workerCleanup = async () => {
        stopConfigWatcher();
        await shutdownOcr();
        process.exit(0);
    };
    process.once('SIGTERM', workerCleanup);
    process.once('SIGINT', workerCleanup);
}
