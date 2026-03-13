/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试（最多 5 次）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { getProxyFetchOptions, rotateProxy, getCurrentProxyUrl } from './proxy-agent.js';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// Chrome 浏览器请求头模拟
function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': '',  // Cursor 不再校验此字段
    };
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg}`);
            // 4xx 错误（除 429）换代理也无法解决，直接抛出
            const httpMatch = msg.match(/HTTP (\d+)/);
            if (httpMatch) {
                const status = parseInt(httpMatch[1]);
                if (status >= 400 && status < 500 && status !== 429) {
                    throw err;
                }
            }
            if (attempt < maxRetries) {
                await rotateProxy();
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const headers = getChromeHeaders();

    const proxyInfo = getCurrentProxyUrl() ?? 'none';
    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}, proxy=${proxyInfo}`);

    const config = getConfig();
    const controller = new AbortController();

    // 连接超时：等待服务器开始响应的最长时间（TCP+TLS+首字节）
    const CONNECT_TIMEOUT_MS = 15000;
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        console.warn('[Cursor] 连接超时（15s 未收到响应头），中止请求');
        controller.abort();
    }, CONNECT_TIMEOUT_MS);

    // 空闲超时：流式读取时，指定时间内无新数据则中断
    const IDLE_TIMEOUT_MS = config.timeout * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
            controller.abort();
        }, IDLE_TIMEOUT_MS);
    };

    try {
        const resp = await fetch(CURSOR_CHAT_API, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
            ...getProxyFetchOptions(),
        } as any);

        // 已收到响应头，清除连接超时，改用空闲超时保护流式读取
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        resetIdleTimer();

        console.log(`[Cursor] 收到响应头: HTTP ${resp.status} ${resp.statusText}`);

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let eventCount = 0;
        let textDeltaCount = 0;
        const otherEvents: string[] = [];

        const processEvent = (data: string) => {
            if (data === '[DONE]') return;
            try {
                const event: CursorSSEEvent = JSON.parse(data);
                eventCount++;
                if (event.type === 'text-delta') {
                    textDeltaCount++;
                } else {
                    otherEvents.push(data);
                }
                onChunk(event);
            } catch {
                // 非 JSON 数据，原样记录
                otherEvents.push(data);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // 每次收到数据就重置空闲计时器
            resetIdleTimer();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;
                processEvent(data);
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) processEvent(data);
        }

        console.log(`[Cursor] 流读取完成: 共${eventCount}个事件, text-delta=${textDeltaCount}`);
        if (textDeltaCount === 0 && otherEvents.length > 0) {
            console.warn(`[Cursor] 无 text-delta 事件，收到的其他事件:`);
            for (const e of otherEvents) {
                console.warn(`  ${e}`);
            }
        }
        if (eventCount === 0) {
            throw new Error('Cursor 返回空响应（0个SSE事件），可能被代理拦截或账号异常');
        }
    } finally {
        if (connectTimer) clearTimeout(connectTimer);
        if (idleTimer) clearTimeout(idleTimer);
    }
}

/**
 * 发送非流式请求，收集完整响应
 */
export async function sendCursorRequestFull(req: CursorChatRequest): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    });
    return fullText;
}
