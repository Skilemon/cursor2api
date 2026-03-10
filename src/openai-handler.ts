/**
 * openai-handler.ts - OpenAI Chat Completions API 兼容处理器
 *
 * 将 OpenAI 格式请求转换为内部 Anthropic 格式，复用现有 Cursor 交互管道
 * 支持流式和非流式响应、工具调用
 */

import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
    OpenAIChatRequest,
    OpenAIMessage,
    OpenAIChatCompletion,
    OpenAIChatCompletionChunk,
    OpenAIToolCall,
} from './openai-types.js';
import type {
    AnthropicRequest,
    AnthropicMessage,
    AnthropicContentBlock,
    AnthropicTool,
    CursorChatRequest,
    CursorSSEEvent,
} from './types.js';
import { convertToCursorRequest, parseToolCalls, hasToolCalls } from './converter.js';
import { sendCursorRequest, sendCursorRequestFull } from './cursor-client.js';
import { getConfig } from './config.js';
import {
    isRefusal,
    sanitizeResponse,
    isIdentityProbe,
    isToolCapabilityQuestion,
    buildRetryRequest,
    CLAUDE_IDENTITY_RESPONSE,
    CLAUDE_TOOLS_RESPONSE,
    MAX_REFUSAL_RETRIES,
} from './handler.js';

function chatId(): string {
    return 'chatcmpl-' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function toolCallId(): string {
    return 'call_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

// ==================== 请求转换：OpenAI → Anthropic ====================

/**
 * 将 OpenAI Chat Completions 请求转换为内部 Anthropic 格式
 * 这样可以完全复用现有的 convertToCursorRequest 管道
 */
function convertToAnthropicRequest(body: OpenAIChatRequest): AnthropicRequest {
    const messages: AnthropicMessage[] = [];
    let systemPrompt: string | undefined;

    for (const msg of body.messages) {
        switch (msg.role) {
            case 'system':
                // OpenAI system → Anthropic system
                systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + extractOpenAIContent(msg);
                break;

            case 'user':
                messages.push({
                    role: 'user',
                    content: extractOpenAIContent(msg),
                });
                break;

            case 'assistant': {
                // 助手消息可能包含 tool_calls
                const blocks: AnthropicContentBlock[] = [];
                const contentBlocks = extractOpenAIContentBlocks(msg);

                if (typeof contentBlocks === 'string' && contentBlocks) {
                    blocks.push({ type: 'text', text: contentBlocks });
                } else if (Array.isArray(contentBlocks)) {
                    blocks.push(...contentBlocks);
                }

                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const tc of msg.tool_calls) {
                        let args: Record<string, unknown> = {};
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = { input: tc.function.arguments };
                        }
                        blocks.push({
                            type: 'tool_use',
                            id: tc.id,
                            name: tc.function.name,
                            input: args,
                        });
                    }
                }

                messages.push({
                    role: 'assistant',
                    content: blocks.length > 0 ? blocks : '',
                });
                break;
            }

            case 'tool': {
                // OpenAI tool result → Anthropic tool_result
                messages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: extractOpenAIContent(msg),
                    }] as AnthropicContentBlock[],
                });
                break;
            }
        }
    }

    // 转换工具定义：OpenAI function → Anthropic tool
    const tools: AnthropicTool[] | undefined = body.tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));

    return {
        model: body.model,
        messages,
        max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
        stream: body.stream,
        system: systemPrompt,
        tools,
        temperature: body.temperature,
        top_p: body.top_p,
        stop_sequences: body.stop
            ? (Array.isArray(body.stop) ? body.stop : [body.stop])
            : undefined,
    };
}

/**
 * 从 OpenAI 消息中提取文本或多模态内容块
 */
function extractOpenAIContentBlocks(msg: OpenAIMessage): string | AnthropicContentBlock[] {
    if (msg.content === null || msg.content === undefined) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const p of msg.content) {
            if (p.type === 'text' && p.text) {
                blocks.push({ type: 'text', text: p.text });
            } else if (p.type === 'image_url' && p.image_url?.url) {
                const url = p.image_url.url;
                if (url.startsWith('data:')) {
                    const match = url.match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        blocks.push({
                            type: 'image',
                            source: { type: 'base64', media_type: match[1], data: match[2] }
                        });
                    }
                } else {
                    blocks.push({
                        type: 'image',
                        source: { type: 'url', media_type: 'image/jpeg', data: url }
                    });
                }
            }
        }
        return blocks.length > 0 ? blocks : '';
    }
    return String(msg.content);
}

/**
 * 仅提取纯文本（用于系统提示词和旧行为）
 */
function extractOpenAIContent(msg: OpenAIMessage): string {
    const blocks = extractOpenAIContentBlocks(msg);
    if (typeof blocks === 'string') return blocks;
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// ==================== 主处理入口 ====================

export async function handleOpenAIChatCompletions(req: Request, res: Response): Promise<void> {
    const body = req.body as OpenAIChatRequest;

    const lastUserMsg = body.messages?.slice().reverse().find((m: OpenAIMessage) => m.role === 'user');
    const lastUserText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
            ? lastUserMsg.content.filter((b: {type: string; text?: string}) => b.type === 'text').map((b: {type: string; text?: string}) => b.text).join(' ')
            : '';
    console.log(`[OpenAI] 收到请求: model=${body.model}, messages=${body.messages?.length}, stream=${body.stream}, tools=${body.tools?.length ?? 0}`);
    console.log(`[OpenAI] 最后用户消息: ${lastUserText.substring(0, 200)}${lastUserText.length > 200 ? '...' : ''}`);

    try {
        // Step 1: OpenAI → Anthropic 格式
        const anthropicReq = convertToAnthropicRequest(body);

        // 注意：图片预处理已移入 convertToCursorRequest → preprocessImages() 统一处理

        // Step 1.6: 身份探针拦截（复用 Anthropic handler 的逻辑）
        if (isIdentityProbe(anthropicReq)) {
            console.log(`[OpenAI] 拦截到身份探针，返回模拟响应`);
            const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions. Please let me know what we should work on!";
            if (body.stream) {
                return handleOpenAIMockStream(res, body, mockText);
            } else {
                return handleOpenAIMockNonStream(res, body, mockText);
            }
        }

        // Step 2: Anthropic → Cursor 格式（复用现有管道）
        const cursorReq = await convertToCursorRequest(anthropicReq);

        if (body.stream) {
            await handleOpenAIStream(res, cursorReq, body, anthropicReq);
        } else {
            await handleOpenAINonStream(res, cursorReq, body, anthropicReq);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[OpenAI] 请求处理失败:`, message);
        res.status(500).json({
            error: {
                message,
                type: 'server_error',
                code: 'internal_error',
            },
        });
    }
}

// ==================== 身份探针模拟响应 ====================

function handleOpenAIMockStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: mockText }, finish_reason: null }],
    });
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    res.write('data: [DONE]\n\n');
    res.end();
}

function handleOpenAIMockNonStream(res: Response, body: OpenAIChatRequest, mockText: string): void {
    res.json({
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content: mockText },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 15, completion_tokens: 35, total_tokens: 50 },
    });
}

// ==================== 流式处理（OpenAI SSE 格式） ====================

async function handleOpenAIStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const id = chatId();
    const created = Math.floor(Date.now() / 1000);
    const model = body.model;
    const hasTools = (body.tools?.length ?? 0) > 0;

    // 发送 role delta
    writeOpenAISSE(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
        }],
    });

    let fullResponse = '';
    let activeCursorReq = cursorReq;
    let retryCount = 0;

    // 统一缓冲模式：先缓冲全部响应，再检测拒绝和处理
    const executeStream = async () => {
        fullResponse = '';
        await sendCursorRequest(activeCursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;
            fullResponse += event.delta;
        });
    };

    try {
        await executeStream();
        console.log(`[OpenAI] 原始响应 (${fullResponse.length} chars): ${fullResponse.substring(0, 300)}${fullResponse.length > 300 ? '...' : ''}`);

        // 无工具模式：检测拒绝并自动重试
        if (!hasTools) {
            while (isRefusal(fullResponse) && retryCount < MAX_REFUSAL_RETRIES) {
                retryCount++;
                console.log(`[OpenAI] 检测到拒绝（第${retryCount}次），自动重试...原始: ${fullResponse.substring(0, 80)}...`);
                const retryBody = buildRetryRequest(anthropicReq, retryCount - 1);
                activeCursorReq = await convertToCursorRequest(retryBody);
                await executeStream();
            }
            if (isRefusal(fullResponse)) {
                if (isToolCapabilityQuestion(anthropicReq)) {
                    console.log(`[OpenAI] 工具能力询问被拒绝，返回 Claude 能力描述`);
                    fullResponse = CLAUDE_TOOLS_RESPONSE;
                } else {
                    console.log(`[OpenAI] 重试${MAX_REFUSAL_RETRIES}次后仍被拒绝，返回 Claude 身份回复`);
                    fullResponse = CLAUDE_IDENTITY_RESPONSE;
                }
            }
        }

        let finishReason: 'stop' | 'tool_calls' = 'stop';

        if (hasTools) {
            const { toolCalls, cleanText } = parseToolCalls(fullResponse);
            console.log(`[OpenAI] 工具解析结果: ${toolCalls.length} 个工具调用, cleanText长度=${cleanText.length}`);
            if (toolCalls.length > 0) console.log(`[OpenAI] 工具列表: ${toolCalls.map(t => t.name).join(', ')}`);

            if (toolCalls.length > 0) {
                finishReason = 'tool_calls';

                // 发送工具调用前的残余文本（清洗后）
                let cleanOutput = isRefusal(cleanText) ? '' : cleanText;
                cleanOutput = sanitizeResponse(cleanOutput);
                if (cleanOutput) {
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: { content: cleanOutput },
                            finish_reason: null,
                        }],
                    });
                }

                // 发送每个工具调用
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    writeOpenAISSE(res, {
                        id, object: 'chat.completion.chunk', created, model,
                        choices: [{
                            index: 0,
                            delta: {
                                tool_calls: [{
                                    index: i,
                                    id: toolCallId(),
                                    type: 'function',
                                    function: {
                                        name: tc.name,
                                        arguments: JSON.stringify(tc.arguments),
                                    },
                                }],
                            },
                            finish_reason: null,
                        }],
                    });
                }
            } else {
                // 误报：发送清洗后的文本
                let textToSend = fullResponse;
                if (isRefusal(fullResponse)) {
                    textToSend = 'I understand the request. Let me proceed with the appropriate action. Could you clarify what specific task you would like me to perform?';
                } else {
                    textToSend = sanitizeResponse(fullResponse);
                }
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { content: textToSend },
                        finish_reason: null,
                    }],
                });
            }
        } else {
            // 无工具模式或无工具调用 — 统一清洗后发送
            const sanitized = sanitizeResponse(fullResponse);
            if (sanitized) {
                writeOpenAISSE(res, {
                    id, object: 'chat.completion.chunk', created, model,
                    choices: [{
                        index: 0,
                        delta: { content: sanitized },
                        finish_reason: null,
                    }],
                });
            }
        }

        // 发送完成 chunk
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
            }],
        });

        res.write('data: [DONE]\n\n');

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeOpenAISSE(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{
                index: 0,
                delta: { content: `\n\n[Error: ${message}]` },
                finish_reason: 'stop',
            }],
        });
        res.write('data: [DONE]\n\n');
    }

    res.end();
}

// ==================== 非流式处理 ====================

async function handleOpenAINonStream(
    res: Response,
    cursorReq: CursorChatRequest,
    body: OpenAIChatRequest,
    anthropicReq: AnthropicRequest,
): Promise<void> {
    let fullText = await sendCursorRequestFull(cursorReq);
    const hasTools = (body.tools?.length ?? 0) > 0;

    console.log(`[OpenAI] 原始响应 (${fullText.length} chars): ${fullText.substring(0, 300)}...`);

    // 无工具模式：检测拒绝并自动重试
    if (!hasTools && isRefusal(fullText)) {
        for (let attempt = 0; attempt < MAX_REFUSAL_RETRIES; attempt++) {
            console.log(`[OpenAI] 非流式：检测到拒绝（第${attempt + 1}次重试）...原始: ${fullText.substring(0, 80)}...`);
            const retryBody = buildRetryRequest(anthropicReq, attempt);
            const retryCursorReq = await convertToCursorRequest(retryBody);
            fullText = await sendCursorRequestFull(retryCursorReq);
            if (!isRefusal(fullText)) break;
        }
        if (isRefusal(fullText)) {
            if (isToolCapabilityQuestion(anthropicReq)) {
                console.log(`[OpenAI] 非流式：工具能力询问被拒绝，返回 Claude 能力描述`);
                fullText = CLAUDE_TOOLS_RESPONSE;
            } else {
                console.log(`[OpenAI] 非流式：重试${MAX_REFUSAL_RETRIES}次后仍被拒绝，返回 Claude 身份回复`);
                fullText = CLAUDE_IDENTITY_RESPONSE;
            }
        }
    }

    let content: string | null = fullText;
    let toolCalls: OpenAIToolCall[] | undefined;
    let finishReason: 'stop' | 'tool_calls' = 'stop';

    if (hasTools) {
        const parsed = parseToolCalls(fullText);

        if (parsed.toolCalls.length > 0) {
            finishReason = 'tool_calls';
            // 清洗拒绝文本
            let cleanText = parsed.cleanText;
            if (isRefusal(cleanText)) {
                console.log(`[OpenAI] 抑制工具模式下的拒绝文本: ${cleanText.substring(0, 100)}...`);
                cleanText = '';
            }
            content = sanitizeResponse(cleanText) || null;

            toolCalls = parsed.toolCalls.map(tc => ({
                id: toolCallId(),
                type: 'function' as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                },
            }));
        } else {
            // 无工具调用，检查拒绝
            if (isRefusal(fullText)) {
                content = 'I understand the request. Let me proceed with the appropriate action. Could you clarify what specific task you would like me to perform?';
            } else {
                content = sanitizeResponse(fullText);
            }
        }
    } else {
        // 无工具模式：清洗响应
        content = sanitizeResponse(fullText);
    }

    const response: OpenAIChatCompletion = {
        id: chatId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content,
                ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
        }],
        usage: {
            prompt_tokens: 100,
            completion_tokens: Math.ceil(fullText.length / 4),
            total_tokens: 100 + Math.ceil(fullText.length / 4),
        },
    };

    res.json(response);
}

// ==================== 工具函数 ====================

function writeOpenAISSE(res: Response, data: OpenAIChatCompletionChunk): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // @ts-expect-error flush exists on ServerResponse when compression is used
    if (typeof res.flush === 'function') res.flush();
}

