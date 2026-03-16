/**
 * logger.ts - 全链路日志系统 v3
 *
 * 核心升级：
 * - 存储完整的请求参数（messages, system prompt, tools）
 * - 存储完整的模型返回内容（raw response）
 * - 存储转换后的 Cursor 请求
 * - 阶段耗时追踪 (Phase Timing)
 * - TTFT (Time To First Token)
 * - 全部通过 Web UI 可视化
 */

import { EventEmitter } from 'events';

// ==================== 类型定义 ====================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSource = 'Handler' | 'OpenAI' | 'Cursor' | 'Auth' | 'System' | 'Converter';
export type LogPhase = 
    | 'receive' | 'auth' | 'convert' | 'intercept' | 'send'
    | 'response' | 'refusal' | 'retry' | 'truncation' | 'continuation'
    | 'thinking' | 'toolparse' | 'sanitize' | 'stream' | 'complete' | 'error';

export interface LogEntry {
    id: string;
    requestId: string;
    timestamp: number;
    level: LogLevel;
    source: LogSource;
    phase: LogPhase;
    message: string;
    details?: unknown;
    duration?: number;
}

export interface PhaseTiming {
    phase: LogPhase;
    label: string;
    startTime: number;
    endTime?: number;
    duration?: number;
}

/** 
 * 完整请求数据 — 存储每个请求的全量参数和响应
 */
export interface RequestPayload {
    // ===== 原始请求 =====
    /** 原始请求 body（Anthropic 或 OpenAI 格式） */
    originalRequest?: unknown;
    /** System prompt（提取出来方便查看） */
    systemPrompt?: string;
    /** 用户消息列表摘要 */
    messages?: Array<{ role: string; contentPreview: string; contentLength: number; hasImages?: boolean }>;
    /** 工具定义列表 */
    tools?: Array<{ name: string; description?: string }>;
    
    // ===== 转换后请求 =====
    /** 转换后的 Cursor 请求 */
    cursorRequest?: unknown;
    /** Cursor 消息列表摘要 */
    cursorMessages?: Array<{ role: string; contentPreview: string; contentLength: number }>;
    
    // ===== 模型响应 =====
    /** 原始模型返回全文 */
    rawResponse?: string;
    /** 清洗/处理后的最终响应 */
    finalResponse?: string;
    /** Thinking 内容 */
    thinkingContent?: string;
    /** 工具调用解析结果 */
    toolCalls?: unknown[];
    /** 每次重试的原始响应 */
    retryResponses?: Array<{ attempt: number; response: string; reason: string }>;
    /** 每次续写的原始响应 */
    continuationResponses?: Array<{ index: number; response: string; dedupedLength: number }>;
}

export interface RequestSummary {
    requestId: string;
    startTime: number;
    endTime?: number;
    method: string;
    path: string;
    model: string;
    stream: boolean;
    apiFormat: 'anthropic' | 'openai' | 'responses';
    hasTools: boolean;
    toolCount: number;
    messageCount: number;
    status: 'processing' | 'success' | 'error' | 'intercepted';
    responseChars: number;
    retryCount: number;
    continuationCount: number;
    stopReason?: string;
    error?: string;
    toolCallsDetected: number;
    ttft?: number;
    cursorApiTime?: number;
    phaseTimings: PhaseTiming[];
    thinkingChars: number;
    systemPromptLength: number;
}

// ==================== 存储 ====================

const MAX_ENTRIES = 5000;
const MAX_REQUESTS = 200;

let logCounter = 0;
const logEntries: LogEntry[] = [];
const requestSummaries: Map<string, RequestSummary> = new Map();
const requestPayloads: Map<string, RequestPayload> = new Map();
const requestOrder: string[] = [];

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

function shortId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

// ==================== 统计 ====================

export function getStats() {
    let success = 0, error = 0, intercepted = 0, processing = 0;
    let totalTime = 0, timeCount = 0, totalTTFT = 0, ttftCount = 0;
    for (const s of requestSummaries.values()) {
        if (s.status === 'success') success++;
        else if (s.status === 'error') error++;
        else if (s.status === 'intercepted') intercepted++;
        else if (s.status === 'processing') processing++;
        if (s.endTime) { totalTime += s.endTime - s.startTime; timeCount++; }
        if (s.ttft) { totalTTFT += s.ttft; ttftCount++; }
    }
    return {
        totalRequests: requestSummaries.size,
        successCount: success, errorCount: error,
        interceptedCount: intercepted, processingCount: processing,
        avgResponseTime: timeCount > 0 ? Math.round(totalTime / timeCount) : 0,
        avgTTFT: ttftCount > 0 ? Math.round(totalTTFT / ttftCount) : 0,
        totalLogEntries: logEntries.length,
    };
}

// ==================== 核心 API ====================

export function createRequestLogger(opts: {
    method: string;
    path: string;
    model: string;
    stream: boolean;
    hasTools: boolean;
    toolCount: number;
    messageCount: number;
    apiFormat?: 'anthropic' | 'openai' | 'responses';
    systemPromptLength?: number;
}): RequestLogger {
    const requestId = shortId();
    const summary: RequestSummary = {
        requestId, startTime: Date.now(),
        method: opts.method, path: opts.path, model: opts.model,
        stream: opts.stream,
        apiFormat: opts.apiFormat || (opts.path.includes('chat/completions') ? 'openai' :
                   opts.path.includes('responses') ? 'responses' : 'anthropic'),
        hasTools: opts.hasTools, toolCount: opts.toolCount,
        messageCount: opts.messageCount,
        status: 'processing', responseChars: 0,
        retryCount: 0, continuationCount: 0, toolCallsDetected: 0,
        phaseTimings: [], thinkingChars: 0,
        systemPromptLength: opts.systemPromptLength || 0,
    };
    const payload: RequestPayload = {};
    
    requestSummaries.set(requestId, summary);
    requestPayloads.set(requestId, payload);
    requestOrder.push(requestId);
    
    while (requestOrder.length > MAX_REQUESTS) {
        const oldId = requestOrder.shift()!;
        requestSummaries.delete(oldId);
        requestPayloads.delete(oldId);
    }

    const toolInfo = opts.hasTools ? ` tools=${opts.toolCount}` : '';
    const fmtTag = summary.apiFormat === 'openai' ? ' [OAI]' : summary.apiFormat === 'responses' ? ' [RSP]' : '';
    console.log(`\x1b[36m⟶\x1b[0m [${requestId}] ${opts.method} ${opts.path}${fmtTag} | model=${opts.model} stream=${opts.stream}${toolInfo} msgs=${opts.messageCount}`);
    
    return new RequestLogger(requestId, summary, payload);
}

export function getAllLogs(opts?: { requestId?: string; level?: LogLevel; source?: LogSource; limit?: number; since?: number }): LogEntry[] {
    let result = logEntries;
    if (opts?.requestId) result = result.filter(e => e.requestId === opts.requestId);
    if (opts?.level) {
        const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
        const minLevel = levels[opts.level];
        result = result.filter(e => levels[e.level] >= minLevel);
    }
    if (opts?.source) result = result.filter(e => e.source === opts.source);
    if (opts?.since) result = result.filter(e => e.timestamp > opts!.since!);
    if (opts?.limit) result = result.slice(-opts.limit);
    return result;
}

export function getRequestSummaries(limit?: number): RequestSummary[] {
    const ids = limit ? requestOrder.slice(-limit) : requestOrder;
    return ids.map(id => requestSummaries.get(id)!).filter(Boolean).reverse();
}

/** 获取请求的完整 payload 数据 */
export function getRequestPayload(requestId: string): RequestPayload | undefined {
    return requestPayloads.get(requestId);
}

export function subscribeToLogs(listener: (entry: LogEntry) => void): () => void {
    logEmitter.on('log', listener);
    return () => logEmitter.off('log', listener);
}

export function subscribeToSummaries(listener: (summary: RequestSummary) => void): () => void {
    logEmitter.on('summary', listener);
    return () => logEmitter.off('summary', listener);
}

function addEntry(entry: LogEntry): void {
    logEntries.push(entry);
    while (logEntries.length > MAX_ENTRIES) logEntries.shift();
    logEmitter.emit('log', entry);
}

// ==================== RequestLogger ====================

export class RequestLogger {
    readonly requestId: string;
    private summary: RequestSummary;
    private payload: RequestPayload;
    private activePhase: PhaseTiming | null = null;
    
    constructor(requestId: string, summary: RequestSummary, payload: RequestPayload) {
        this.requestId = requestId;
        this.summary = summary;
        this.payload = payload;
    }
    
    private log(level: LogLevel, source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        addEntry({
            id: `log_${++logCounter}`,
            requestId: this.requestId,
            timestamp: Date.now(),
            level, source, phase, message, details,
            duration: Date.now() - this.summary.startTime,
        });
    }
    
    // ---- 阶段追踪 ----
    startPhase(phase: LogPhase, label: string): void {
        if (this.activePhase && !this.activePhase.endTime) {
            this.activePhase.endTime = Date.now();
            this.activePhase.duration = this.activePhase.endTime - this.activePhase.startTime;
        }
        const t: PhaseTiming = { phase, label, startTime: Date.now() };
        this.activePhase = t;
        this.summary.phaseTimings.push(t);
    }
    endPhase(): void {
        if (this.activePhase && !this.activePhase.endTime) {
            this.activePhase.endTime = Date.now();
            this.activePhase.duration = this.activePhase.endTime - this.activePhase.startTime;
        }
    }
    
    // ---- 便捷方法 ----
    debug(source: LogSource, phase: LogPhase, message: string, details?: unknown): void { this.log('debug', source, phase, message, details); }
    info(source: LogSource, phase: LogPhase, message: string, details?: unknown): void { this.log('info', source, phase, message, details); }
    warn(source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        this.log('warn', source, phase, message, details);
        console.log(`\x1b[33m⚠\x1b[0m [${this.requestId}] ${message}`);
    }
    error(source: LogSource, phase: LogPhase, message: string, details?: unknown): void {
        this.log('error', source, phase, message, details);
        console.error(`\x1b[31m✗\x1b[0m [${this.requestId}] ${message}`);
    }
    
    // ---- 特殊事件 ----
    recordTTFT(): void { this.summary.ttft = Date.now() - this.summary.startTime; }
    recordCursorApiTime(startTime: number): void { this.summary.cursorApiTime = Date.now() - startTime; }
    
    // ---- 全量数据记录 ----
    
    /** 记录原始请求（包含 messages, system, tools 等） */
    recordOriginalRequest(body: any): void {
        // system prompt
        if (typeof body.system === 'string') {
            this.payload.systemPrompt = body.system;
        } else if (Array.isArray(body.system)) {
            this.payload.systemPrompt = body.system.map((b: any) => b.text || '').join('\n');
        }
        
        // messages 摘要 + 完整存储
        if (Array.isArray(body.messages)) {
            const MAX_MSG = 100000; // 单条消息最大存储 100K
            this.payload.messages = body.messages.map((m: any) => {
                let fullContent = '';
                let contentLength = 0;
                let hasImages = false;
                if (typeof m.content === 'string') {
                    fullContent = m.content.length > MAX_MSG ? m.content.substring(0, MAX_MSG) + '\n... [截断]' : m.content;
                    contentLength = m.content.length;
                } else if (Array.isArray(m.content)) {
                    const textParts = m.content.filter((c: any) => c.type === 'text');
                    const imageParts = m.content.filter((c: any) => c.type === 'image' || c.type === 'image_url');
                    hasImages = imageParts.length > 0;
                    const text = textParts.map((c: any) => c.text || '').join('\n');
                    fullContent = text.length > MAX_MSG ? text.substring(0, MAX_MSG) + '\n... [截断]' : text;
                    contentLength = text.length;
                    if (hasImages) fullContent += `\n[+${imageParts.length} images]`;
                }
                return { role: m.role, contentPreview: fullContent, contentLength, hasImages };
            });
        }
        
        // tools
        if (Array.isArray(body.tools)) {
            this.payload.tools = body.tools.map((t: any) => ({
                name: t.name || t.function?.name || 'unknown',
                description: (t.description || t.function?.description || '').substring(0, 200),
            }));
        }
        
        // 存全量 (去掉 base64 图片数据避免内存爆炸)
        this.payload.originalRequest = this.sanitizeForStorage(body);
    }
    
    /** 记录转换后的 Cursor 请求 */
    recordCursorRequest(cursorReq: any): void {
        if (Array.isArray(cursorReq.messages)) {
            const MAX_MSG = 100000;
            this.payload.cursorMessages = cursorReq.messages.map((m: any) => {
                // Cursor 消息用 parts 而不是 content
                let text = '';
                if (m.parts && Array.isArray(m.parts)) {
                    text = m.parts.map((p: any) => p.text || '').join('\n');
                } else if (typeof m.content === 'string') {
                    text = m.content;
                } else if (m.content) {
                    text = JSON.stringify(m.content);
                }
                const fullContent = text.length > MAX_MSG ? text.substring(0, MAX_MSG) + '\n... [截断]' : text;
                return {
                    role: m.role,
                    contentPreview: fullContent,
                    contentLength: text.length,
                };
            });
        }
        // 存储不含完整消息体的 cursor 请求元信息
        this.payload.cursorRequest = {
            model: cursorReq.model,
            messageCount: cursorReq.messages?.length,
            totalChars: cursorReq.messages?.reduce((sum: number, m: any) => {
                if (m.parts && Array.isArray(m.parts)) {
                    return sum + m.parts.reduce((s: number, p: any) => s + (p.text?.length || 0), 0);
                }
                const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                return sum + text.length;
            }, 0),
        };
    }
    
    /** 记录模型原始响应 */
    recordRawResponse(text: string): void {
        this.payload.rawResponse = text;
    }
    
    /** 记录最终响应 */
    recordFinalResponse(text: string): void {
        this.payload.finalResponse = text;
    }
    
    /** 记录 thinking 内容 */
    recordThinking(content: string): void {
        this.payload.thinkingContent = content;
        this.summary.thinkingChars = content.length;
    }
    
    /** 记录工具调用 */
    recordToolCalls(calls: unknown[]): void {
        this.payload.toolCalls = calls;
    }
    
    /** 记录重试响应 */
    recordRetryResponse(attempt: number, response: string, reason: string): void {
        if (!this.payload.retryResponses) this.payload.retryResponses = [];
        this.payload.retryResponses.push({ attempt, response, reason });
    }
    
    /** 记录续写响应 */
    recordContinuationResponse(index: number, response: string, dedupedLength: number): void {
        if (!this.payload.continuationResponses) this.payload.continuationResponses = [];
        this.payload.continuationResponses.push({ index, response: response.substring(0, 2000), dedupedLength });
    }
    
    /** 去除 base64 图片数据以节省内存 */
    private sanitizeForStorage(obj: any): any {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(item => this.sanitizeForStorage(item));
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'data' && typeof value === 'string' && (value as string).length > 1000) {
                result[key] = `[base64 data: ${(value as string).length} chars]`;
            } else if (key === 'source' && typeof value === 'object' && (value as any)?.type === 'base64') {
                result[key] = { type: 'base64', media_type: (value as any).media_type, data: `[${((value as any).data?.length || 0)} chars]` };
            } else if (typeof value === 'object') {
                result[key] = this.sanitizeForStorage(value);
            } else {
                result[key] = value;
            }
        }
        return result;
    }
    
    // ---- 摘要更新 ----
    updateSummary(updates: Partial<RequestSummary>): void {
        Object.assign(this.summary, updates);
        logEmitter.emit('summary', this.summary);
    }
    
    complete(responseChars: number, stopReason?: string): void {
        this.endPhase();
        const duration = Date.now() - this.summary.startTime;
        this.summary.endTime = Date.now();
        this.summary.status = 'success';
        this.summary.responseChars = responseChars;
        this.summary.stopReason = stopReason;
        this.log('info', 'System', 'complete', `完成 (${duration}ms, ${responseChars} chars, stop=${stopReason})`);
        logEmitter.emit('summary', this.summary);
        
        const retryInfo = this.summary.retryCount > 0 ? ` retry=${this.summary.retryCount}` : '';
        const contInfo = this.summary.continuationCount > 0 ? ` cont=${this.summary.continuationCount}` : '';
        const toolInfo = this.summary.toolCallsDetected > 0 ? ` tools_called=${this.summary.toolCallsDetected}` : '';
        const ttftInfo = this.summary.ttft ? ` ttft=${this.summary.ttft}ms` : '';
        console.log(`\x1b[32m⟵\x1b[0m [${this.requestId}] ${duration}ms | ${responseChars} chars | stop=${stopReason || 'end_turn'}${ttftInfo}${retryInfo}${contInfo}${toolInfo}`);
    }
    
    intercepted(reason: string): void {
        this.summary.status = 'intercepted';
        this.summary.endTime = Date.now();
        this.log('info', 'System', 'intercept', reason);
        logEmitter.emit('summary', this.summary);
        console.log(`\x1b[35m⊘\x1b[0m [${this.requestId}] 拦截: ${reason}`);
    }
    
    fail(error: string): void {
        this.endPhase();
        this.summary.status = 'error';
        this.summary.endTime = Date.now();
        this.summary.error = error;
        this.log('error', 'System', 'error', error);
        logEmitter.emit('summary', this.summary);
    }
}
