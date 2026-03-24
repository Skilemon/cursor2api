import { readFileSync, existsSync, watch, type FSWatcher } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';

let config: AppConfig;
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 配置变更回调
type ConfigReloadCallback = (newConfig: AppConfig, changes: string[]) => void;
const reloadCallbacks: ConfigReloadCallback[] = [];

export function onConfigReload(cb: ConfigReloadCallback): void {
    reloadCallbacks.push(cb);
}

function parseYamlConfig(defaults: AppConfig): { config: AppConfig; raw: Record<string, unknown> | null } {
    const result = { ...defaults, fingerprint: { ...defaults.fingerprint } };
    let raw: Record<string, unknown> | null = null;

    if (!existsSync('config.yaml')) return { config: result, raw };

    try {
        const content = readFileSync('config.yaml', 'utf-8');
        const yaml = parseYaml(content);
        raw = yaml;

        if (yaml.port) result.port = yaml.port;
        if (yaml.timeout) result.timeout = yaml.timeout;
        if (yaml.proxy) result.proxy = yaml.proxy;
        if (yaml.proxy_pool_url) result.proxyPoolUrl = yaml.proxy_pool_url;
        if (Array.isArray(yaml.proxy_list) && yaml.proxy_list.length > 0) result.proxyList = yaml.proxy_list;
        if (Array.isArray(yaml.nodes) && yaml.nodes.length > 0) result.nodes = yaml.nodes;
        if (yaml.subscription) result.subscription = yaml.subscription;
        if (yaml.mihomo) result.mihomo = yaml.mihomo;
        if (yaml.workers) result.workers = yaml.workers;
        if (yaml.cursor_model) result.cursorModel = yaml.cursor_model;
        if (typeof yaml.max_auto_continue === 'number') result.maxAutoContinue = yaml.max_auto_continue;
        if (typeof yaml.max_history_messages === 'number') result.maxHistoryMessages = yaml.max_history_messages;
        if (typeof yaml.max_history_tokens === 'number') result.maxHistoryTokens = yaml.max_history_tokens;
        if (yaml.fingerprint) {
            if (yaml.fingerprint.user_agent) result.fingerprint.userAgent = yaml.fingerprint.user_agent;
        }
        if (yaml.vision) {
            result.vision = {
                enabled: yaml.vision.enabled !== false,
                mode: yaml.vision.mode || 'ocr',
                baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                apiKey: yaml.vision.api_key || '',
                model: yaml.vision.model || 'gpt-4o-mini',
                proxy: yaml.vision.proxy || undefined,
            };
        }
        if (yaml.auth_tokens) {
            result.authTokens = Array.isArray(yaml.auth_tokens)
                ? yaml.auth_tokens.map(String)
                : String(yaml.auth_tokens).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        if (yaml.auth_token) result.authTokens = [String(yaml.auth_token)];
        if (yaml.compression !== undefined) {
            const c = yaml.compression;
            result.compression = {
                enabled: c.enabled !== false,
                level: [1, 2, 3].includes(c.level) ? c.level : 1,
                keepRecent: typeof c.keep_recent === 'number' ? c.keep_recent : 10,
                earlyMsgMaxChars: typeof c.early_msg_max_chars === 'number' ? c.early_msg_max_chars : 4000,
            };
        }
        if (yaml.thinking !== undefined) {
            result.thinking = {
                enabled: yaml.thinking.enabled !== false,
            };
        }
        if (yaml.logging !== undefined) {
            const persistModes = ['compact', 'full', 'summary'];
            result.logging = {
                file_enabled: yaml.logging.file_enabled === true,
                dir: yaml.logging.dir || './logs',
                max_days: typeof yaml.logging.max_days === 'number' ? yaml.logging.max_days : 7,
                persist_mode: persistModes.includes(yaml.logging.persist_mode) ? yaml.logging.persist_mode : 'summary',
                db_enabled: yaml.logging.db_enabled === true,
                db_path: yaml.logging.db_path || './logs/cursor2api.db',
            };
        }
        if (yaml.tools !== undefined) {
            const t = yaml.tools;
            const validModes = ['compact', 'full', 'names_only'];
            result.tools = {
                schemaMode: validModes.includes(t.schema_mode) ? t.schema_mode : 'full',
                descriptionMaxLength: typeof t.description_max_length === 'number' ? t.description_max_length : 0,
                includeOnly: Array.isArray(t.include_only) ? t.include_only.map(String) : undefined,
                exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : undefined,
                passthrough: t.passthrough === true,
                disabled: t.disabled === true,
            };
        }
        if (yaml.sanitize_response !== undefined) {
            result.sanitizeEnabled = yaml.sanitize_response === true;
        }
        if (Array.isArray(yaml.refusal_patterns)) {
            result.refusalPatterns = yaml.refusal_patterns.map(String).filter(Boolean);
        }
    } catch (e) {
        console.warn('[Config] 读取 config.yaml 失败:', e);
    }

    return { config: result, raw };
}

function applyEnvOverrides(cfg: AppConfig): void {
    if (process.env.PORT) cfg.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) cfg.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) cfg.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) cfg.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.MAX_AUTO_CONTINUE !== undefined) cfg.maxAutoContinue = parseInt(process.env.MAX_AUTO_CONTINUE);
    if (process.env.MAX_HISTORY_MESSAGES !== undefined) cfg.maxHistoryMessages = parseInt(process.env.MAX_HISTORY_MESSAGES);
    if (process.env.MAX_HISTORY_TOKENS !== undefined) cfg.maxHistoryTokens = parseInt(process.env.MAX_HISTORY_TOKENS);
    if (process.env.AUTH_TOKEN) {
        cfg.authTokens = process.env.AUTH_TOKEN.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (process.env.COMPRESSION_ENABLED !== undefined) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        cfg.compression.enabled = process.env.COMPRESSION_ENABLED !== 'false' && process.env.COMPRESSION_ENABLED !== '0';
    }
    if (process.env.COMPRESSION_LEVEL) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        const lvl = parseInt(process.env.COMPRESSION_LEVEL);
        if (lvl >= 1 && lvl <= 3) cfg.compression.level = lvl as 1 | 2 | 3;
    }
    if (process.env.THINKING_ENABLED !== undefined) {
        cfg.thinking = {
            enabled: process.env.THINKING_ENABLED !== 'false' && process.env.THINKING_ENABLED !== '0',
        };
    }
    if (process.env.LOG_FILE_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.file_enabled = process.env.LOG_FILE_ENABLED === 'true' || process.env.LOG_FILE_ENABLED === '1';
    }
    if (process.env.LOG_DIR) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.dir = process.env.LOG_DIR;
    }
    if (process.env.LOG_PERSIST_MODE) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.persist_mode = process.env.LOG_PERSIST_MODE === 'full'
            ? 'full'
            : process.env.LOG_PERSIST_MODE === 'summary'
                ? 'summary'
                : 'compact';
    }
    if (process.env.LOG_DB_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_enabled = process.env.LOG_DB_ENABLED === 'true' || process.env.LOG_DB_ENABLED === '1';
    }
    if (process.env.LOG_DB_PATH) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_path = process.env.LOG_DB_PATH;
    }
    if (process.env.TOOLS_PASSTHROUGH !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.passthrough = process.env.TOOLS_PASSTHROUGH === 'true' || process.env.TOOLS_PASSTHROUGH === '1';
    }
    if (process.env.TOOLS_DISABLED !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.disabled = process.env.TOOLS_DISABLED === 'true' || process.env.TOOLS_DISABLED === '1';
    }
    if (process.env.SANITIZE_RESPONSE !== undefined) {
        cfg.sanitizeEnabled = process.env.SANITIZE_RESPONSE === 'true' || process.env.SANITIZE_RESPONSE === '1';
    }
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) cfg.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }
}

function defaultConfig(): AppConfig {
    return {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        maxAutoContinue: 0,
        maxHistoryMessages: -1,
        maxHistoryTokens: 150000,
        sanitizeEnabled: false,
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };
}

function detectChanges(oldCfg: AppConfig, newCfg: AppConfig): string[] {
    const changes: string[] = [];

    if (oldCfg.port !== newCfg.port) changes.push(`port: ${oldCfg.port} → ${newCfg.port}`);
    if (oldCfg.timeout !== newCfg.timeout) changes.push(`timeout: ${oldCfg.timeout} → ${newCfg.timeout}`);
    if (oldCfg.proxy !== newCfg.proxy) changes.push(`proxy: ${oldCfg.proxy || '(none)'} → ${newCfg.proxy || '(none)'}`);
    if (oldCfg.cursorModel !== newCfg.cursorModel) changes.push(`cursor_model: ${oldCfg.cursorModel} → ${newCfg.cursorModel}`);
    if (oldCfg.maxAutoContinue !== newCfg.maxAutoContinue) changes.push(`max_auto_continue: ${oldCfg.maxAutoContinue} → ${newCfg.maxAutoContinue}`);
    if (oldCfg.maxHistoryMessages !== newCfg.maxHistoryMessages) changes.push(`max_history_messages: ${oldCfg.maxHistoryMessages} → ${newCfg.maxHistoryMessages}`);
    if (oldCfg.maxHistoryTokens !== newCfg.maxHistoryTokens) changes.push(`max_history_tokens: ${oldCfg.maxHistoryTokens} → ${newCfg.maxHistoryTokens}`);
    if (oldCfg.workers !== newCfg.workers) changes.push(`workers: ${oldCfg.workers} → ${newCfg.workers}`);
    if (oldCfg.proxyPoolUrl !== newCfg.proxyPoolUrl) changes.push(`proxy_pool_url: (changed)`);

    const oldTokens = (oldCfg.authTokens || []).join(',');
    const newTokens = (newCfg.authTokens || []).join(',');
    if (oldTokens !== newTokens) changes.push(`auth_tokens: ${oldCfg.authTokens?.length || 0} → ${newCfg.authTokens?.length || 0} token(s)`);

    if (JSON.stringify(oldCfg.thinking) !== JSON.stringify(newCfg.thinking)) changes.push(`thinking: ${JSON.stringify(oldCfg.thinking)} → ${JSON.stringify(newCfg.thinking)}`);
    if (JSON.stringify(oldCfg.vision) !== JSON.stringify(newCfg.vision)) changes.push('vision: (changed)');
    if (JSON.stringify(oldCfg.compression) !== JSON.stringify(newCfg.compression)) changes.push('compression: (changed)');
    if (JSON.stringify(oldCfg.logging) !== JSON.stringify(newCfg.logging)) changes.push('logging: (changed)');
    if (JSON.stringify(oldCfg.tools) !== JSON.stringify(newCfg.tools)) changes.push('tools: (changed)');
    if (oldCfg.sanitizeEnabled !== newCfg.sanitizeEnabled) changes.push(`sanitize_response: ${oldCfg.sanitizeEnabled} → ${newCfg.sanitizeEnabled}`);
    if (JSON.stringify(oldCfg.refusalPatterns) !== JSON.stringify(newCfg.refusalPatterns)) changes.push(`refusal_patterns: ${oldCfg.refusalPatterns?.length || 0} → ${newCfg.refusalPatterns?.length || 0} rule(s)`);
    if (oldCfg.fingerprint.userAgent !== newCfg.fingerprint.userAgent) changes.push('fingerprint: (changed)');

    return changes;
}

export function getConfig(): AppConfig {
    if (config) return config;

    const defaults = defaultConfig();
    const { config: parsed } = parseYamlConfig(defaults);
    applyEnvOverrides(parsed);
    config = parsed;
    return config;
}

export function initConfigWatcher(): void {
    if (watcher) return;
    if (!existsSync('config.yaml')) {
        console.log('[Config] config.yaml 不存在，跳过热重载监听');
        return;
    }

    const DEBOUNCE_MS = 500;

    watcher = watch('config.yaml', (eventType) => {
        if (eventType !== 'change') return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            try {
                if (!existsSync('config.yaml')) {
                    console.warn('[Config] ⚠️  config.yaml 已被删除，保持当前配置');
                    return;
                }

                const oldConfig = config;
                const oldPort = oldConfig.port;

                const defaults = defaultConfig();
                const { config: newConfig } = parseYamlConfig(defaults);
                applyEnvOverrides(newConfig);

                const changes = detectChanges(oldConfig, newConfig);
                if (changes.length === 0) return;

                if (newConfig.port !== oldPort) {
                    console.warn(`[Config] ⚠️  检测到 port 变更 (${oldPort} → ${newConfig.port})，端口变更需要重启服务才能生效`);
                    newConfig.port = oldPort;
                }

                config = newConfig;

                console.log(`[Config] 🔄 config.yaml 已热重载，${changes.length} 项变更:`);
                changes.forEach(c => console.log(`  └─ ${c}`));

                for (const cb of reloadCallbacks) {
                    try {
                        cb(newConfig, changes);
                    } catch (e) {
                        console.warn('[Config] 热重载回调执行失败:', e);
                    }
                }
            } catch (e) {
                console.error('[Config] ❌ 热重载失败，保持当前配置:', e);
            }
        }, DEBOUNCE_MS);
    });

    watcher.on('error', (err) => {
        console.error('[Config] ❌ 文件监听异常:', err);
        watcher = null;
        setTimeout(() => {
            console.log('[Config] 🔄 尝试重新建立 config.yaml 监听...');
            initConfigWatcher();
        }, 2000);
    });

    console.log('[Config] 👁️  正在监听 config.yaml 变更（热重载已启用）');
}

export function stopConfigWatcher(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}
