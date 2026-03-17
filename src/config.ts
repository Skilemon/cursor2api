import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';

let config: AppConfig;

export function getConfig(): AppConfig {
    if (config) return config;

    // 默认配置
    config = {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        enableThinking: true,
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };

    // 从 config.yaml 加载
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.proxy_pool_url) config.proxyPoolUrl = yaml.proxy_pool_url;
            if (Array.isArray(yaml.proxy_list) && yaml.proxy_list.length > 0) config.proxyList = yaml.proxy_list;
            if (Array.isArray(yaml.nodes) && yaml.nodes.length > 0) config.nodes = yaml.nodes;
            if (yaml.subscription) config.subscription = yaml.subscription;
            if (yaml.mihomo) config.mihomo = yaml.mihomo;
            if (yaml.workers) config.workers = yaml.workers;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.enable_thinking !== undefined) config.enableThinking = yaml.enable_thinking;
            if (yaml.fingerprint) {
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
            if (yaml.auth_tokens) {
                config.authTokens = Array.isArray(yaml.auth_tokens)
                    ? yaml.auth_tokens
                    : String(yaml.auth_tokens).split(',').map((t: string) => t.trim()).filter(Boolean);
            }
            if (yaml.auth_token) config.authTokens = [yaml.auth_token];
            if (yaml.vision) {
                config.vision = {
                    enabled: yaml.vision.enabled !== false,
                    mode: yaml.vision.mode || 'ocr',
                    baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                    apiKey: yaml.vision.api_key || '',
                    model: yaml.vision.model || 'gpt-4o-mini',
                    ...(yaml.vision.proxy ? { proxy: yaml.vision.proxy } : {}),
                };
            }
            // ★ 历史压缩配置
            if (yaml.compression !== undefined) {
                const c = yaml.compression;
                config.compression = {
                    enabled: c.enabled !== false,
                    level: [1, 2, 3].includes(c.level) ? c.level : 2,
                    keepRecent: typeof c.keep_recent === 'number' ? c.keep_recent : 6,
                    earlyMsgMaxChars: typeof c.early_msg_max_chars === 'number' ? c.early_msg_max_chars : 2000,
                };
            }
            // ★ Thinking 开关（最高优先级）
            if (yaml.thinking !== undefined) {
                config.thinking = {
                    enabled: yaml.thinking.enabled !== false,
                };
            }
            // ★ 日志文件持久化
            if (yaml.logging !== undefined) {
                config.logging = {
                    file_enabled: yaml.logging.file_enabled === true,
                    dir: yaml.logging.dir || './logs',
                    max_days: typeof yaml.logging.max_days === 'number' ? yaml.logging.max_days : 7,
                };
            }
            // ★ 工具处理配置
            if (yaml.tools !== undefined) {
                const t = yaml.tools;
                const validModes = ['compact', 'full', 'names_only'];
                config.tools = {
                    schemaMode: validModes.includes(t.schema_mode) ? t.schema_mode : 'compact',
                    descriptionMaxLength: typeof t.description_max_length === 'number' ? t.description_max_length : 50,
                    includeOnly: Array.isArray(t.include_only) ? t.include_only.map(String) : undefined,
                    exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : undefined,
                };
            }
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.PROXY_POOL_URL) config.proxyPoolUrl = process.env.PROXY_POOL_URL;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.AUTH_TOKEN) config.authTokens = process.env.AUTH_TOKEN.split(',').map(t => t.trim()).filter(Boolean);
    if (process.env.AUTH_TOKENS) config.authTokens = process.env.AUTH_TOKENS.split(',').map(t => t.trim()).filter(Boolean);
    if (process.env.ENABLE_THINKING !== undefined) config.enableThinking = process.env.ENABLE_THINKING !== 'false';
    // 压缩环境变量覆盖
    if (process.env.COMPRESSION_ENABLED !== undefined) {
        if (!config.compression) config.compression = { enabled: true, level: 2, keepRecent: 6, earlyMsgMaxChars: 2000 };
        config.compression.enabled = process.env.COMPRESSION_ENABLED !== 'false' && process.env.COMPRESSION_ENABLED !== '0';
    }
    if (process.env.COMPRESSION_LEVEL !== undefined) {
        const lvl = parseInt(process.env.COMPRESSION_LEVEL);
        if ([1, 2, 3].includes(lvl)) {
            if (!config.compression) config.compression = { enabled: true, level: 2, keepRecent: 6, earlyMsgMaxChars: 2000 };
            config.compression.level = lvl as 1 | 2 | 3;
        }
    }

    // THINKING_ENABLED 环境变量覆盖
    if (process.env.THINKING_ENABLED !== undefined) {
        if (!config.thinking) config.thinking = { enabled: true };
        config.thinking.enabled = process.env.THINKING_ENABLED === 'true' || process.env.THINKING_ENABLED === '1';
    }

    // 日志文件持久化环境变量覆盖
    if (process.env.LOG_FILE_ENABLED !== undefined) {
        if (!config.logging) config.logging = { file_enabled: false, dir: './logs', max_days: 7 };
        config.logging.file_enabled = process.env.LOG_FILE_ENABLED === 'true' || process.env.LOG_FILE_ENABLED === '1';
    }
    if (process.env.LOG_DIR !== undefined) {
        if (!config.logging) config.logging = { file_enabled: false, dir: './logs', max_days: 7 };
        config.logging.dir = process.env.LOG_DIR;
    }

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}
