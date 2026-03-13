/**
 * thinking.ts - Thinking 块提取与处理
 *
 * 从 Cursor API 返回的文本响应中提取 <thinking>...</thinking> 标签，
 * 将其转换为 Anthropic API 的 thinking content block 或 OpenAI 的 reasoning_content。
 *
 * 参考：cursor2api-go 项目的 CursorProtocolParser 实现
 * 区别：由于本项目已经缓冲了完整响应（fullResponse），
 *       不需要流式 FSM 解析器，直接在缓冲文本上做正则提取即可。
 */

export interface ThinkingBlock {
    thinking: string;   // 提取出的 thinking 内容
}

export interface ExtractThinkingResult {
    thinkingBlocks: ThinkingBlock[];   // 所有提取出的 thinking 块
    cleanText: string;                  // 移除 thinking 标签后的干净文本
}

/**
 * 从响应文本中提取所有 <thinking>...</thinking> 块
 *
 * 支持：
 * - 多个 thinking 块
 * - thinking 块在文本的任何位置（开头、中间、结尾）
 * - 未闭合的 thinking 块（被截断的情况）
 *
 * @param text 原始响应文本
 * @returns thinking 块列表和移除标签后的干净文本
 */
export function extractThinking(text: string): ExtractThinkingResult {
    const thinkingBlocks: ThinkingBlock[] = [];

    if (!text || !text.includes('<thinking>')) {
        return { thinkingBlocks, cleanText: text };
    }

    // 使用全局正则匹配所有 <thinking>...</thinking> 块
    // dotAll flag (s) 让 . 匹配换行符
    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    let match: RegExpExecArray | null;
    const ranges: Array<{ start: number; end: number }> = [];

    while ((match = thinkingRegex.exec(text)) !== null) {
        const thinkingContent = match[1].trim();
        if (thinkingContent) {
            thinkingBlocks.push({ thinking: thinkingContent });
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    // 处理未闭合的 <thinking> 块（截断场景）
    // 检查最后一个 <thinking> 是否在最后一个 </thinking> 之后
    const lastOpenIdx = text.lastIndexOf('<thinking>');
    const lastCloseIdx = text.lastIndexOf('</thinking>');
    if (lastOpenIdx >= 0 && (lastCloseIdx < 0 || lastOpenIdx > lastCloseIdx)) {
        // 未闭合的 thinking 块 — 提取剩余内容
        const unclosedContent = text.substring(lastOpenIdx + '<thinking>'.length).trim();
        if (unclosedContent) {
            thinkingBlocks.push({ thinking: unclosedContent });
        }
        ranges.push({ start: lastOpenIdx, end: text.length });
    }

    // 从后往前移除已提取的 thinking 块，生成干净文本
    // 先按 start 降序排列以安全删除
    ranges.sort((a, b) => b.start - a.start);
    let cleanText = text;
    for (const range of ranges) {
        cleanText = cleanText.substring(0, range.start) + cleanText.substring(range.end);
    }

    // 清理多余空行（thinking 块移除后可能留下连续空行）
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    if (thinkingBlocks.length > 0) {
        console.log(`[Thinking] 提取到 ${thinkingBlocks.length} 个 thinking 块, 总 ${thinkingBlocks.reduce((s, b) => s + b.thinking.length, 0)} chars`);
    }

    return { thinkingBlocks, cleanText };
}

/**
 * Thinking 提示词 — 注入到系统提示词中，引导模型使用 <thinking> 标签
 *
 * 与 cursor2api-go 的 thinkingHint 保持一致
 */
export const THINKING_HINT = `You may use <thinking>...</thinking> for brief private reasoning. HARD LIMITS: max 3 lines, max 120 words. Do NOT write code, full solutions, or long analysis inside thinking. Never repeat thinking content in the final response.`;
