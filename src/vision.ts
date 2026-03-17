import { getConfig } from './config.js';
import type { AnthropicMessage, AnthropicContentBlock } from './types.js';
import { getVisionProxyFetchOptions } from './proxy-agent.js';
import { createWorker } from 'tesseract.js';
import type { Worker } from 'tesseract.js';
import crypto from 'crypto';

// Global cache for image parsing results
// Key: sampled hash of the image data string, Value: Extracted text
const imageParsingCache = new Map<string, string>();
const MAX_CACHE_SIZE = 100;

function setCache(hash: string, text: string) {
    if (imageParsingCache.size >= MAX_CACHE_SIZE) {
        // Evict oldest entry (Map preserves insertion order)
        const firstKey = imageParsingCache.keys().next().value;
        if (firstKey) {
            imageParsingCache.delete(firstKey);
        }
    }
    imageParsingCache.set(hash, text);
}

/**
 * 采样哈希：只取头128+尾128+总长度，O(1) 而非 O(n)
 * 仅用于缓存键，不用于安全校验
 */
function getImageHash(imageSource: string): string {
    const len = imageSource.length;
    // 短字符串直接全量哈希（URL 等场景）
    if (len <= 512) {
        return crypto.createHash('sha256').update(imageSource).digest('hex');
    }
    const head = imageSource.slice(0, 128);
    const tail = imageSource.slice(-128);
    return crypto.createHash('sha256').update(`${len}:${head}:${tail}`).digest('hex');
}

// ==================== OCR Worker 单例池 ====================
// 避免每次请求冷启动 Tesseract WASM（1~3s），改为进程级单例复用

let _ocrWorker: Worker | null = null;
let _ocrBusy = false;
const _ocrQueue: Array<() => void> = [];

async function acquireOcrWorker(): Promise<Worker> {
    if (!_ocrWorker) {
        _ocrWorker = await createWorker('eng+chi_sim');
    }
    if (_ocrBusy) {
        await new Promise<void>(resolve => _ocrQueue.push(resolve));
    }
    _ocrBusy = true;
    return _ocrWorker;
}

function releaseOcrWorker(): void {
    _ocrBusy = false;
    const next = _ocrQueue.shift();
    if (next) next();
}

/** 进程退出时清理 OCR Worker */
export async function shutdownOcr(): Promise<void> {
    if (_ocrWorker) {
        await _ocrWorker.terminate();
        _ocrWorker = null;
    }
}

// ==================== Vision 主入口 ====================

export async function applyVisionInterceptor(messages: AnthropicMessage[]): Promise<void> {
    const config = getConfig();
    if (!config.vision?.enabled) return;

    for (const msg of messages) {
        if (!Array.isArray(msg.content)) continue;

        let hasImages = false;
        const newContent: AnthropicContentBlock[] = [];
        const imagesToAnalyze: AnthropicContentBlock[] = [];

        for (const block of msg.content) {
            if (block.type === 'image') {
                hasImages = true;
                imagesToAnalyze.push(block);
            } else {
                newContent.push(block);
            }
        }

        if (hasImages && imagesToAnalyze.length > 0) {
            try {
                let descriptions = '';
                if (config.vision.mode === 'ocr') {
                    console.log(`[Vision] 启用纯本地 OCR 模式，正在处理 ${imagesToAnalyze.length} 张图片... (无需 API Key)`);
                    descriptions = await processWithLocalOCR(imagesToAnalyze);
                } else {
                    console.log(`[Vision] 启用外部 API 模式，正在处理 ${imagesToAnalyze.length} 张图片...`);
                    descriptions = await callVisionAPI(imagesToAnalyze);
                }

                // Add descriptions as a simulated system text block
                newContent.push({
                    type: 'text',
                    text: `\n\n[System: The user attached ${imagesToAnalyze.length} image(s). Visual analysis/OCR extracted the following context:\n${descriptions}]\n\n`
                });

                msg.content = newContent;
            } catch (e) {
                console.error("[Vision API Error]", e);
                newContent.push({
                    type: 'text',
                    text: `\n\n[System: The user attached image(s), but the Vision interceptor failed to process them. Error: ${(e as Error).message}]\n\n`
                });
                msg.content = newContent;
            }
        }
    }
}

// ==================== 本地 OCR ====================

async function processWithLocalOCR(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    const results: string[] = new Array(imageBlocks.length).fill('');
    const imagesToProcess: { index: number; source: string; hash: string }[] = [];

    // 检查缓存
    for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        let imageSource = '';

        if (img.type === 'image' && img.source) {
            const sourceData = img.source.data || img.source.url;
            if (img.source.type === 'base64' && sourceData) {
                const mime = img.source.media_type || 'image/jpeg';
                imageSource = `data:${mime};base64,${sourceData}`;
            } else if (img.source.type === 'url' && sourceData) {
                imageSource = sourceData;
            }
        }

        if (imageSource) {
            const hash = getImageHash(imageSource);
            const cached = imageParsingCache.get(hash);
            if (cached !== undefined) {
                console.log(`[Vision] Image ${i + 1} found in cache, skipping OCR.`);
                results[i] = `--- Image ${i + 1} OCR Text ---\n${cached}\n\n`;
            } else {
                imagesToProcess.push({ index: i, source: imageSource, hash });
            }
        }
    }

    if (imagesToProcess.length > 0) {
        // 复用单例 Worker，不再每次冷启动
        const worker = await acquireOcrWorker();
        try {
            for (const { index, source, hash } of imagesToProcess) {
                try {
                    const { data: { text } } = await worker.recognize(source);
                    const extractedText = text.trim() || '(No text detected in this image)';
                    setCache(hash, extractedText);
                    results[index] = `--- Image ${index + 1} OCR Text ---\n${extractedText}\n\n`;
                } catch (err) {
                    console.error(`[Vision OCR] Failed to parse image ${index + 1}:`, err);
                    results[index] = `--- Image ${index + 1} ---\n(Failed to parse image with local OCR)\n\n`;
                }
            }
        } finally {
            releaseOcrWorker();
        }
    }

    return results.join('');
}

// ==================== 外部 Vision API ====================

/**
 * 并行处理多张图片（最多3张并发），相比串行最多节省 N-1 倍延迟
 */
async function callVisionAPI(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    const config = getConfig().vision!;
    const results: string[] = new Array(imageBlocks.length).fill('');

    // 收集需要处理的图片（排除缓存命中）
    const tasks: Array<() => Promise<void>> = [];

    for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        let url = '';

        if (img.type === 'image' && img.source) {
            const sourceData = img.source.data || img.source.url;
            if (img.source.type === 'base64' && sourceData) {
                const mime = img.source.media_type || 'image/jpeg';
                url = `data:${mime};base64,${sourceData}`;
            } else if (img.source.type === 'url' && sourceData) {
                url = sourceData;
            }
        }

        if (!url) continue;

        const hash = getImageHash(url);
        const cached = imageParsingCache.get(hash);
        if (cached !== undefined) {
            console.log(`[Vision API] Image ${i + 1} cache hit.`);
            results[i] = `--- Image ${i + 1} ---\n${cached}\n\n`;
            continue;
        }

        const idx = i;
        const capturedUrl = url;
        const capturedHash = hash;
        tasks.push(async () => {
            const parts: any[] = [
                { type: 'text', text: 'Please describe the attached image in detail. If it contains code, UI elements, or error messages, explicitly write them out.' },
                { type: 'image_url', image_url: { url: capturedUrl } }
            ];

            const payload = {
                model: config.model,
                messages: [{ role: 'user', content: parts }],
                max_tokens: 1500
            };

            const res = await fetch(config.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                body: JSON.stringify(payload),
                ...getVisionProxyFetchOptions(),
            } as any);

            if (!res.ok) {
                throw new Error(`Vision API returned status ${res.status}: ${await res.text()}`);
            }

            const data = await res.json() as any;
            const result = data.choices?.[0]?.message?.content || 'No description returned.';
            setCache(capturedHash, result);
            results[idx] = `--- Image ${idx + 1} ---\n${result}\n\n`;
        });
    }

    // 并行执行，最多3张并发
    if (tasks.length > 0) {
        await runParallel(tasks, 3);
    }

    return results.join('');
}

/**
 * 轻量并发控制，无需第三方依赖
 * 保序（results 数组已按 index 写入），单个失败会抛出
 */
async function runParallel(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
    const queue = [...tasks];
    async function worker() {
        while (queue.length > 0) {
            const task = queue.shift()!;
            await task();
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
    );
}
