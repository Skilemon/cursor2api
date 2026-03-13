/**
 * proxy-agent.ts - 代理支持模块
 *
 * 支持三种模式（优先级从高到低）：
 * 1. 代理分配服务（PROXY_ALLOCATOR_URL）：从分配服务获取不重复IP，定时续约，失败自动换IP
 * 2. 静态代理池（PROXY_POOL_URL）：每次直接从代理池拿IP，不保证不重复
 * 3. 静态代理（PROXY）：固定IP
 */

import { ProxyAgent, Agent, buildConnector } from 'undici';
import { SocksClient } from 'socks';
import type { SocksProxy } from 'socks';
import { getConfig } from './config.js';

let cachedAgent: ProxyAgent | Agent | undefined;
let currentProxyUrl: string | undefined;
let renewTimer: ReturnType<typeof setInterval> | undefined;

// 续约间隔：LEASE_TTL 的一半，默认30秒
const RENEW_INTERVAL_MS = parseInt(process.env.LEASE_TTL_MS || '60000') / 2;

/**
 * 从代理分配服务申请一个不重复的代理IP
 */
async function allocateFromService(): Promise<string> {
    const allocatorUrl = process.env.PROXY_ALLOCATOR_URL!;
    const resp = await fetch(`${allocatorUrl}/allocate`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`分配服务请求失败: ${resp.status}`);
    const json = await resp.json() as { success: boolean; proxy: string; error?: string };
    if (!json.success || !json.proxy) throw new Error(json.error || '分配服务返回数据异常');
    return json.proxy;
}

/**
 * 向分配服务续约当前IP
 */
async function renewLease(proxy: string): Promise<void> {
    const allocatorUrl = process.env.PROXY_ALLOCATOR_URL!;
    try {
        await fetch(`${allocatorUrl}/renew`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxy }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        // 续约失败不中断业务，等下次重试
    }
}

/**
 * 向分配服务释放当前IP
 */
async function releaseLease(proxy: string): Promise<void> {
    const allocatorUrl = process.env.PROXY_ALLOCATOR_URL!;
    try {
        await fetch(`${allocatorUrl}/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ proxy }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {}
}

/**
 * 从代理池API直接获取一个代理URL
 */
async function fetchProxyFromPool(): Promise<string> {
    const config = getConfig();
    const poolUrl = config.proxyPoolUrl!;
    const resp = await fetch(poolUrl, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`代理池请求失败: ${resp.status}`);
    const json = await resp.json() as { success: boolean; data: { proxy: string } };
    if (!json.success || !json.data?.proxy) throw new Error('代理池返回数据异常');
    return json.data.proxy;
}

/**
 * 解析 SOCKS 代理 URL，返回 SocksProxy 对象
 * 支持格式: socks5://user:pass@host:port 或 socks5://host:port
 */
function parseSocksUrl(proxyUrl: string): SocksProxy {
    const url = new URL(proxyUrl);
    const type = url.protocol === 'socks4:' ? 4 : 5;
    const proxy: SocksProxy = {
        host: url.hostname,
        port: parseInt(url.port),
        type,
    };
    if (url.username) {
        proxy.userId = decodeURIComponent(url.username);
        proxy.password = decodeURIComponent(url.password);
    }
    return proxy;
}

/**
 * 判断是否为 SOCKS 代理 URL
 */
function isSocksProxy(proxyUrl: string): boolean {
    return proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://');
}

/**
 * 创建 SOCKS 代理 Agent（通过自定义 connector）
 */
function createSocksAgent(proxyUrl: string): Agent {
    const socksProxy = parseSocksUrl(proxyUrl);
    const tlsConnector = buildConnector({});

    return new Agent({
        connect(options, callback) {
            const { hostname, port, protocol } = options as { hostname: string; port: string; protocol: string };
            SocksClient.createConnection(
                {
                    proxy: socksProxy,
                    command: 'connect',
                    destination: { host: hostname, port: parseInt(port) },
                },
                (err, info) => {
                    if (err || !info) return callback(err ?? new Error('SOCKS connection failed'), null);
                    if (protocol === 'https:') {
                        tlsConnector({ ...options, httpSocket: info.socket }, callback);
                    } else {
                        callback(null, info.socket as never);
                    }
                }
            );
        },
    });
}

function stopRenewTimer(): void {
    if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = undefined;
    }
}

async function destroyCurrent(): Promise<void> {
    stopRenewTimer();
    if (cachedAgent) {
        try { await cachedAgent.close(); } catch {}
        cachedAgent = undefined;
    }
    if (currentProxyUrl && process.env.PROXY_ALLOCATOR_URL) {
        await releaseLease(currentProxyUrl);
    }
    currentProxyUrl = undefined;
}

/**
 * 初始化代理，force=true 时强制重新获取（换IP）
 */
export async function initProxy(force = false): Promise<void> {
    if (!force && cachedAgent) return;

    await destroyCurrent();

    const config = getConfig();
    const allocatorUrl = process.env.PROXY_ALLOCATOR_URL;

    if (allocatorUrl) {
        // 模式1：代理分配服务（保证不重复）
        const proxyUrl = await allocateFromService();
        currentProxyUrl = proxyUrl;
        cachedAgent = isSocksProxy(proxyUrl) ? createSocksAgent(proxyUrl) : new ProxyAgent(proxyUrl);
        console.log(`[Proxy] 分配服务获取代理: ${proxyUrl}`);

        // 定时续约
        renewTimer = setInterval(() => {
            renewLease(proxyUrl).catch(() => {});
        }, RENEW_INTERVAL_MS);

    } else if (config.proxyPoolUrl) {
        // 模式2：直接从代理池获取（不保证不重复）
        const proxyUrl = await fetchProxyFromPool();
        currentProxyUrl = proxyUrl;
        cachedAgent = isSocksProxy(proxyUrl) ? createSocksAgent(proxyUrl) : new ProxyAgent(proxyUrl);
        console.log(`[Proxy] 代理池获取代理: ${proxyUrl}`);

    } else if (config.proxy) {
        // 模式3：静态代理
        currentProxyUrl = config.proxy;
        cachedAgent = isSocksProxy(config.proxy) ? createSocksAgent(config.proxy) : new ProxyAgent(config.proxy);
        console.log(`[Proxy] 使用静态代理: ${config.proxy}`);

    } else {
        console.log('[Proxy] 未配置代理，直连');
    }
}

/**
 * 代理失败时调用，强制换一个新IP
 */
export async function rotateProxy(): Promise<void> {
    console.log(`[Proxy] 代理失败，切换新IP...`);
    await initProxy(true);
}

export function getProxyFetchOptions(): Record<string, unknown> {
    return cachedAgent ? { dispatcher: cachedAgent } : {};
}

// 进程退出时释放租约
process.on('SIGTERM', async () => { await destroyCurrent(); process.exit(0); });
process.on('SIGINT', async () => { await destroyCurrent(); process.exit(0); });
