import { getConfig } from './config.js';
import type { AnthropicMessage, AnthropicContentBlock } from './types.js';
import { getProxyFetchOptions } from './proxy-agent.js';
import { createWorker } from 'tesseract.js';
import crypto from 'crypto';

// Global cache for image parsing results
// Key: SHA-256 hash of the image data string, Value: Extracted text
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

function getImageHash(imageSource: string): string {
    return crypto.createHash('sha256').update(imageSource).digest('hex');
}

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

async function processWithLocalOCR(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    let combinedText = '';
    const imagesToProcess: { index: number, source: string, hash: string }[] = [];

    // Check cache first
    for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        let imageSource: string = '';

        if (img.type === 'image' && img.source?.data) {
            if (img.source.type === 'base64') {
                const mime = img.source.media_type || 'image/jpeg';
                imageSource = `data:${mime};base64,${img.source.data}`;
            } else if (img.source.type === 'url') {
                imageSource = img.source.data;
            }
        }

        if (imageSource) {
            const hash = getImageHash(imageSource);
            if (imageParsingCache.has(hash)) {
                console.log(`[Vision] Image ${i + 1} found in cache, skipping OCR.`);
                combinedText += `--- Image ${i + 1} OCR Text ---\n${imageParsingCache.get(hash)}\n\n`;
            } else {
                imagesToProcess.push({ index: i, source: imageSource, hash });
            }
        }
    }

    if (imagesToProcess.length > 0) {
        const worker = await createWorker('eng+chi_sim');

        for (const { index, source, hash } of imagesToProcess) {
            try {
                const { data: { text } } = await worker.recognize(source);
                const extractedText = text.trim() || '(No text detected in this image)';
                setCache(hash, extractedText);
                combinedText += `--- Image ${index + 1} OCR Text ---\n${extractedText}\n\n`;
            } catch (err) {
                console.error(`[Vision OCR] Failed to parse image ${index + 1}:`, err);
                combinedText += `--- Image ${index + 1} ---\n(Failed to parse image with local OCR)\n\n`;
            }
        }
        await worker.terminate();
    }

    return combinedText;
}

async function callVisionAPI(imageBlocks: AnthropicContentBlock[]): Promise<string> {
    const config = getConfig().vision!;
    let combinedText = '';

    for (let i = 0; i < imageBlocks.length; i++) {
        const img = imageBlocks[i];
        let url = '';

        if (img.type === 'image' && img.source?.data) {
            if (img.source.type === 'base64') {
                const mime = img.source.media_type || 'image/jpeg';
                url = `data:${mime};base64,${img.source.data}`;
            } else if (img.source.type === 'url') {
                url = img.source.data;
            }
        }

        if (!url) continue;

        const hash = getImageHash(url);
        const cached = imageParsingCache.get(hash);
        if (cached !== undefined) {
            console.log(`[Vision API] Image ${i + 1} cache hit.`);
            combinedText += `--- Image ${i + 1} ---\n${cached}\n\n`;
            continue;
        }

        const parts: any[] = [
            { type: 'text', text: 'Please describe the attached image in detail. If it contains code, UI elements, or error messages, explicitly write them out.' },
            { type: 'image_url', image_url: { url } }
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
            ...getProxyFetchOptions(),
        } as any);

        if (!res.ok) {
            throw new Error(`Vision API returned status ${res.status}: ${await res.text()}`);
        }

        const data = await res.json() as any;
        const result = data.choices?.[0]?.message?.content || 'No description returned.';
        setCache(hash, result);
        combinedText += `--- Image ${i + 1} ---\n${result}\n\n`;
    }

    return combinedText;
}
