/**
 * Cursor2API v2 - 入口
 *
 * 单容器多进程模式：
 * - 主进程：启动内置代理分配服务 + 用 cluster 派生 Worker
 * - Worker：各自独立持有一个代理IP，处理 HTTP 请求
 * - cluster 自动将请求轮询分发给各 Worker
 *
 * 环境变量：
 *   WORKERS=4        Worker 数量，默认 CPU 核心数
 *   PROXY_POOL_URL   代理池API地址（多进程模式必填）
 *   PROXY=...        静态代理（单进程模式用）
 */

import 'dotenv/config';
import cluster from 'cluster';
import os from 'os';
import { createRequire } from 'module';
import { getConfig } from './config.js';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };

// ==================== 主进程 ====================

if (cluster.isPrimary) {
    const config = getConfig();
    const workerCount = parseInt(process.env.WORKERS || '') || config.workers || os.cpus().length;
    const useAllocator = !!process.env.PROXY_POOL_URL;

    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log(`  ║        Cursor2API v${VERSION.padEnd(21)}║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  Port:    ${String(config.port).padEnd(27)}║`);
    console.log(`  ║  Workers: ${String(workerCount).padEnd(27)}║`);
    console.log(`  ║  Proxy:   ${(useAllocator ? 'pool (allocator)' : (config.proxy || 'none')).padEnd(27)}║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    // 如果配置了代理池，先在主进程启动分配服务
    if (useAllocator) {
        const { startAllocatorServer } = await import('./proxy-allocator.js');
        const allocatorPort = parseInt(process.env.ALLOCATOR_PORT || '3011');
        startAllocatorServer(allocatorPort);
        // 让 Worker 通过 localhost 访问分配服务
        process.env.PROXY_ALLOCATOR_URL = `http://127.0.0.1:${allocatorPort}`;
    }

    // 派生 Worker
    for (let i = 0; i < workerCount; i++) {
        cluster.fork();
    }

    // Worker 退出时自动重启
    cluster.on('exit', (worker, code, signal) => {
        console.error(`[Cluster] Worker ${worker.process.pid} 退出 (code=${code}, signal=${signal})，重启中...`);
        cluster.fork();
    });

} else {
    // ==================== Worker 进程 ====================
    await startWorker();
}

async function startWorker() {
    const express = (await import('express')).default;
    const { getConfig } = await import('./config.js');
    const { initProxy } = await import('./proxy-agent.js');
    const { handleMessages, listModels, countTokens } = await import('./handler.js');
    const { handleOpenAIChatCompletions, handleOpenAIResponses } = await import('./openai-handler.js');

    const config = getConfig();

    // 初始化代理（从分配服务或静态配置），失败重试最多5次
    for (let i = 1; ; i++) {
        try {
            await initProxy();
            break;
        } catch (err) {
            if (i >= 5) throw err;
            console.warn(`[Worker ${process.pid}] initProxy 失败 (${i}/5)，3s 后重试...`, err);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    const app = express();
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

    // 路由
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
            endpoints: {
                anthropic_messages: 'POST /v1/messages',
                openai_chat: 'POST /v1/chat/completions',
                openai_responses: 'POST /v1/responses',
                models: 'GET /v1/models',
                health: 'GET /health',
            },
        });
    });

    app.listen(config.port, () => {
        console.log(`[Worker ${process.pid}] 已启动，监听 :${config.port}`);
    });
}
