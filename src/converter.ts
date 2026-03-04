/**
 * converter.ts - 核心协议转换器
 *
 * 职责：
 * 1. Anthropic Messages API → Cursor /api/chat 请求转换
 * 2. Tool 定义 → 提示词注入（让 Cursor 背后的 Claude 模型输出工具调用）
 * 3. AI 响应中的工具调用解析（XML 标签 → Anthropic tool_use 格式）
 * 4. tool_result → 文本转换（用于回传给 Cursor API）
 */

import { v4 as uuidv4 } from 'uuid';
import type {
    AnthropicRequest,
    AnthropicMessage,
    AnthropicContentBlock,
    AnthropicTool,
    CursorChatRequest,
    CursorMessage,
    ParsedToolCall,
} from './types.js';
import { getConfig } from './config.js';

// ==================== Tool Prompt 注入 ====================

/**
 * 将 Anthropic 工具定义转换为系统提示词
 * Claude 模型原生理解工具调用，我们用 XML 格式让它通过纯文本输出工具调用
 */
export function buildToolSystemPrompt(tools: AnthropicTool[]): string {
    if (!tools || tools.length === 0) return '';

    const toolDescriptions = tools.map((tool) => {
        let desc = `<tool name="${tool.name}">`;
        if (tool.description) {
            desc += `\n<description>${tool.description}</description>`;
        }
        if (tool.input_schema) {
            desc += `\n<parameters>${JSON.stringify(tool.input_schema)}</parameters>`;
        }
        desc += '\n</tool>';
        return desc;
    }).join('\n');

    return `In this environment you have access to a set of tools you can use to answer the user's question.

You may call them like this:
<antml_tool_call>
<tool_name>$TOOL_NAME</tool_name>
<tool_input>
{"$PARAMETER_NAME": "$PARAMETER_VALUE"}
</tool_input>
</antml_tool_call>

Here are the tools available:
<tools>
${toolDescriptions}
</tools>

Important rules:
- When you need to use a tool, output the XML tool call block EXACTLY as shown above
- You can make multiple tool calls in a single response
- After making tool call(s), STOP your response and wait for the tool results
- Do NOT wrap tool calls in markdown code blocks
- Output tool calls directly in your response text`;
}

// ==================== 请求转换 ====================

/**
 * Anthropic Messages API 请求 → Cursor /api/chat 请求
 */
export function convertToCursorRequest(req: AnthropicRequest): CursorChatRequest {
    const config = getConfig();
    const messages: CursorMessage[] = [];

    // 1. 构建系统消息（合并 system + tool prompt）
    let systemText = '';

    // 提取原始 system prompt
    if (req.system) {
        if (typeof req.system === 'string') {
            systemText = req.system;
        } else if (Array.isArray(req.system)) {
            systemText = req.system
                .filter((b) => b.type === 'text' && b.text)
                .map((b) => b.text!)
                .join('\n');
        }
    }

    // 注入工具提示词
    const toolPrompt = buildToolSystemPrompt(req.tools ?? []);
    if (toolPrompt) {
        systemText = systemText ? `${systemText}\n\n${toolPrompt}` : toolPrompt;
    }

    if (systemText) {
        messages.push({
            parts: [{ type: 'text', text: systemText }],
            id: shortId(),
            role: 'system',
        });
    }

    // 2. 转换用户/助手消息
    for (const msg of req.messages) {
        const text = extractMessageText(msg);
        if (text) {
            messages.push({
                parts: [{ type: 'text', text }],
                id: shortId(),
                role: msg.role,
            });
        }
    }

    return {
        model: config.cursorModel,
        id: shortId(),
        messages,
        trigger: 'submit-message',
    };
}

/**
 * 从 Anthropic 消息中提取纯文本
 * 处理 string、ContentBlock[]、tool_use、tool_result 等各种格式
 */
function extractMessageText(msg: AnthropicMessage): string {
    const { content } = msg;

    if (typeof content === 'string') return content;

    if (!Array.isArray(content)) return String(content);

    const parts: string[] = [];

    for (const block of content as AnthropicContentBlock[]) {
        switch (block.type) {
            case 'text':
                if (block.text) parts.push(block.text);
                break;

            case 'tool_use':
                // 助手发出的工具调用 → 转换为 XML 格式文本
                parts.push(formatToolCallAsXml(block.name!, block.input ?? {}));
                break;

            case 'tool_result': {
                // 工具执行结果 → 转换为文本
                const resultText = extractToolResultText(block);
                const prefix = block.is_error ? '[Tool Error]' : '[Tool Result]';
                parts.push(`${prefix} (tool_use_id: ${block.tool_use_id}):\n${resultText}`);
                break;
            }
        }
    }

    return parts.join('\n\n');
}

/**
 * 将工具调用格式化为 XML（用于助手消息中的 tool_use 块回传）
 */
function formatToolCallAsXml(name: string, input: Record<string, unknown>): string {
    return `<antml_tool_call>
<tool_name>${name}</tool_name>
<tool_input>
${JSON.stringify(input)}
</tool_input>
</antml_tool_call>`;
}

/**
 * 提取 tool_result 的文本内容
 */
function extractToolResultText(block: AnthropicContentBlock): string {
    if (!block.content) return '';
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) {
        return block.content
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('\n');
    }
    return String(block.content);
}

// ==================== 响应解析 ====================

/**
 * 从 AI 响应文本中解析工具调用
 * 匹配 <antml_tool_call>...</antml_tool_call> XML 块
 */
export function parseToolCalls(responseText: string): {
    toolCalls: ParsedToolCall[];
    cleanText: string;
} {
    const toolCalls: ParsedToolCall[] = [];
    let cleanText = responseText;

    // 匹配 <antml_tool_call>...<tool_name>NAME</tool_name>...<tool_input>JSON</tool_input>...</antml_tool_call>
    const toolCallRegex = /<antml_tool_call>\s*<tool_name>(.*?)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/antml_tool_call>/g;

    let match: RegExpExecArray | null;
    while ((match = toolCallRegex.exec(responseText)) !== null) {
        const name = match[1].trim();
        let args: Record<string, unknown> = {};

        try {
            args = JSON.parse(match[2].trim());
        } catch {
            // 如果 JSON 解析失败，尝试作为单个字符串参数
            args = { input: match[2].trim() };
        }

        toolCalls.push({ name, arguments: args });

        // 从文本中移除已解析的工具调用
        cleanText = cleanText.replace(match[0], '');
    }

    return { toolCalls, cleanText: cleanText.trim() };
}

/**
 * 检查文本是否包含工具调用
 */
export function hasToolCalls(text: string): boolean {
    return text.includes('<antml_tool_call>');
}

/**
 * 检查文本中的工具调用是否完整（有结束标签）
 */
export function isToolCallComplete(text: string): boolean {
    const openCount = (text.match(/<antml_tool_call>/g) || []).length;
    const closeCount = (text.match(/<\/antml_tool_call>/g) || []).length;
    return openCount === closeCount;
}

// ==================== 工具函数 ====================

function shortId(): string {
    return uuidv4().replace(/-/g, '').substring(0, 16);
}
