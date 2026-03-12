/**
 * proxy-allocator.ts - 代理分配服务
 *
 * 职责：
 * 作为独立 HTTP 服务运行，给多个 cursor2api 实例分配不重复的代理IP。
 * 内存记录已分配的IP，定时清理过期分配（实例挂掉后自动释放）。
 *
 * 接口：
 *   GET /allocate          - 申请一个代理IP，返回 { proxy: "http://..." }
 *   POST /release          - 主动释放IP，body: { proxy: "http://..." }
 *   GET /status            - 查看当前分配状态
 */

import http from 'http';
import { URL } from 'url';

const PROXY_POOL_URL = process.env.PROXY_POOL_URL!;
const PORT = parseInt(process.env.ALLOCATOR_PORT || '3011');
// 实例心跳超时：超过此时间未续约视为实例已挂，自动释放IP
const LEASE_TTL_MS = parseInt(process.env.LEASE_TTL_MS || '60000');
// 拿到重复IP时的最大重试次数
const MAX_FETCH_RETRIES = 10;

interface Lease {
    proxy: string;
    assignedAt: number;
    expiresAt: number;
}

// 已分配的代理：proxy -> Lease
const leases = new Map<string, Lease>();

function isExpired(lease: Lease): boolean {
    return Date.now() > lease.expiresAt;
}

function cleanExpired(): void {
    for (const [proxy, lease] of leases.entries()) {
        if (isExpired(lease)) {
            console.log(`[Allocator] 租约过期，释放: ${proxy}`);
            leases.delete(proxy);
        }
    }
}

// 定时清理过期租约
setInterval(cleanExpired, 10000);

async function fetchFromPool(): Promise<string> {
    const resp = await fetch(PROXY_POOL_URL, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`代理池请求失败: ${resp.status}`);
    const json = await resp.json() as { success: boolean; data: { proxy: string } };
    if (!json.success || !json.data?.proxy) throw new Error('代理池返回数据异常');
    return json.data.proxy;
}

// 异步锁：防止并发 allocate() 导致同一IP分配给多个 Worker
let allocateLock: Promise<string> | null = null;

/**
 * 从代理池获取一个当前未被分配的代理IP（串行执行，防竞态）
 */
function allocate(): Promise<string> {
    allocateLock = (allocateLock ?? Promise.resolve()).then(async () => {
        cleanExpired();
        for (let i = 0; i < MAX_FETCH_RETRIES; i++) {
            const proxy = await fetchFromPool();
            if (!leases.has(proxy)) {
                const now = Date.now();
                leases.set(proxy, { proxy, assignedAt: now, expiresAt: now + LEASE_TTL_MS });
                console.log(`[Allocator] 分配代理: ${proxy}，当前共 ${leases.size} 个租约`);
                return proxy;
            }
            console.log(`[Allocator] 代理重复，重试 (${i + 1}/${MAX_FETCH_RETRIES}): ${proxy}`);
        }
        throw new Error(`无法获取不重复的代理，已重试 ${MAX_FETCH_RETRIES} 次`);
    }).catch(err => { allocateLock = null; throw err; });
    return allocateLock;
}

function release(proxy: string): void {
    if (leases.delete(proxy)) {
        console.log(`[Allocator] 释放代理: ${proxy}，当前共 ${leases.size} 个租约`);
    }
}

/**
 * 续约（实例定期调用，证明自己还活着）
 */
function renew(proxy: string): boolean {
    const lease = leases.get(proxy);
    if (!lease) return false;
    lease.expiresAt = Date.now() + LEASE_TTL_MS;
    return true;
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (req.method === 'GET' && url.pathname === '/allocate') {
        try {
            const proxy = await allocate();
            respond(res, 200, { success: true, proxy });
        } catch (e) {
            respond(res, 503, { success: false, error: String(e) });
        }
        return;
    }

    if (req.method === 'POST' && url.pathname === '/release') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { proxy } = JSON.parse(body) as { proxy: string };
                release(proxy);
                respond(res, 200, { success: true });
            } catch {
                respond(res, 400, { success: false, error: '参数错误' });
            }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/renew') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { proxy } = JSON.parse(body) as { proxy: string };
                const ok = renew(proxy);
                respond(res, ok ? 200 : 404, { success: ok });
            } catch {
                respond(res, 400, { success: false, error: '参数错误' });
            }
        });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
        cleanExpired();
        respond(res, 200, {
            success: true,
            leases: Array.from(leases.values()).map(l => ({
                proxy: l.proxy,
                assignedAt: new Date(l.assignedAt).toISOString(),
                expiresAt: new Date(l.expiresAt).toISOString(),
            })),
        });
        return;
    }

    respond(res, 404, { success: false, error: 'Not Found' });
});

export function startAllocatorServer(port?: number): void {
    const listenPort = port ?? PORT;
    if (!PROXY_POOL_URL) {
        console.error('[Allocator] 错误：PROXY_POOL_URL 未配置');
        process.exit(1);
    }
    server.listen(listenPort, () => {
        console.log(`[Allocator] 代理分配服务启动，端口 ${listenPort}`);
    });
}

