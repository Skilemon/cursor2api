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
        scriptUrl: '',
        cursorModel: 'anthropic/claude-sonnet-4.6',
        fingerprint: {
            unmaskedVendorWebGL: 'Google Inc. (Intel)',
            unmaskedRendererWebGL: 'ANGLE (Intel, Intel(R) UHD Graphics (0x00009BA4) Direct3D11 vs_5_0 ps_5_0, D3D11)',
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
            if (yaml.script_url) config.scriptUrl = yaml.script_url;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.fingerprint) {
                if (yaml.fingerprint.unmasked_vendor_webgl) config.fingerprint.unmaskedVendorWebGL = yaml.fingerprint.unmasked_vendor_webgl;
                if (yaml.fingerprint.unmasked_renderer_webgl) config.fingerprint.unmaskedRendererWebGL = yaml.fingerprint.unmasked_renderer_webgl;
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.SCRIPT_URL) config.scriptUrl = process.env.SCRIPT_URL;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.UNMASKED_VENDOR_WEBGL) config.fingerprint.unmaskedVendorWebGL = fp.UNMASKED_VENDOR_WEBGL;
            if (fp.UNMASKED_RENDERER_WEBGL) config.fingerprint.unmaskedRendererWebGL = fp.UNMASKED_RENDERER_WEBGL;
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}
