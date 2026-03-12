/**
 * logger.ts - 日志模块
 *
 * 将所有 console.log/warn/error 同时输出到控制台和本地日志文件
 * 日志文件按天滚动：logs/YYYY-MM-DD.log
 */

import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const LOG_DIR = 'logs';

function getLogPath(): string {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return join(LOG_DIR, `${date}.log`);
}

function writeToFile(level: string, args: unknown[]): void {
    try {
        const time = new Date().toISOString();
        const msg = args.map(a =>
            typeof a === 'string' ? a : JSON.stringify(a, null, 2)
        ).join(' ');
        appendFileSync(getLogPath(), `[${time}] [${level}] ${msg}\n`, 'utf-8');
    } catch {
        // 写文件失败不影响主流程
    }
}

export function initLogger(): void {
    try {
        mkdirSync(LOG_DIR, { recursive: true });
    } catch {
        // 目录已存在
    }

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
        origLog(...args);
        writeToFile('INFO', args);
    };

    console.warn = (...args: unknown[]) => {
        origWarn(...args);
        writeToFile('WARN', args);
    };

    console.error = (...args: unknown[]) => {
        origError(...args);
        writeToFile('ERROR', args);
    };
}
