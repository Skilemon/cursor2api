/**
 * mihomo-manager.ts - mihomo 子进程管理
 *
 * 职责：
 * 1. 解析 vless/hysteria2/ss 节点链接
 * 2. 生成 mihomo 配置文件（所有节点 + load-balance + socks5 入口）
 * 3. 启动并监控 mihomo 子进程
 * 4. 暴露本地 socks5 地址供 Worker 使用
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { stringify as yamlStringify } from 'yaml';
import { getConfig } from './config.js';

function getMihomoBin(): string {
    const config = getConfig();
    // 1. config.yaml 显式指定
    if (config.mihomo && existsSync(config.mihomo)) return config.mihomo;
    // 2. 根据当前平台自动选择 bin/ 目录下的二进制
    const platform = process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const candidates = platform === 'win32'
        ? [join('bin', `mihomo-windows-${arch}.exe`)]
        : [join('bin', `mihomo-${arch}`), '/usr/local/bin/mihomo'];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    // 3. 降级到 PATH
    return 'mihomo';
}

const MIHOMO_BASE_PORT = 7891;
const MIHOMO_CONFIG_DIR = process.platform === 'win32'
    ? join(process.env.TEMP || 'C:\\Temp', 'mihomo')
    : '/tmp/mihomo';

// 每个 Worker 对应一个 mihomo 进程
const mihomoProcesses: ChildProcess[] = [];

/** 返回每个 Worker 对应的 socks5 代理 URL 列表 */
export function getMihomoProxyUrls(workerCount: number): string[] {
    return Array.from({ length: workerCount }, (_, i) => `socks5://127.0.0.1:${MIHOMO_BASE_PORT + i}`);
}

// ==================== 节点链接解析 ====================

interface ProxyNode {
    name: string;
    type: string;
    [key: string]: unknown;
}

function parseVless(url: string, index: number): ProxyNode | null {
    try {
        const u = new URL(url);
        const params = u.searchParams;
        const name = decodeURIComponent(u.hash.slice(1)) || `vless-${index}`;
        const node: ProxyNode = {
            name,
            type: 'vless',
            server: u.hostname,
            port: parseInt(u.port),
            uuid: u.username,
            udp: true,
            tls: params.get('security') === 'tls' || params.get('security') === 'reality',
            'client-fingerprint': params.get('fp') || 'chrome',
        };

        const security = params.get('security');
        if (security === 'reality') {
            node['reality-opts'] = {
                'public-key': params.get('pbk') || '',
                'short-id': params.get('sid') || '',
            };
            node.servername = params.get('sni') || '';
        } else if (security === 'tls') {
            node.servername = params.get('sni') || u.hostname;
            node['skip-cert-verify'] = params.get('insecure') === '1';
        }

        const type = params.get('type');
        if (type === 'ws') {
            node.network = 'ws';
            node['ws-opts'] = {
                path: decodeURIComponent(params.get('path') || '/'),
                headers: { Host: params.get('host') || u.hostname },
            };
        } else if (type === 'tcp') {
            node.network = 'tcp';
            const flow = params.get('flow');
            if (flow) node.flow = flow;
        } else if (type === 'grpc') {
            node.network = 'grpc';
            node['grpc-opts'] = {
                'grpc-service-name': decodeURIComponent(params.get('serviceName') || ''),
            };
        }

        return node;
    } catch {
        console.warn(`[Mihomo] 解析 vless 节点失败 (index=${index})`);
        return null;
    }
}

function parseSS(url: string, index: number): ProxyNode | null {
    try {
        const u = new URL(url);
        const name = decodeURIComponent(u.hash.slice(1)) || `ss-${index}`;
        // userinfo 可能是 base64 编码的 method:password
        let method = '';
        let password = '';
        const userinfo = u.username;
        if (userinfo) {
            try {
                const decoded = Buffer.from(userinfo, 'base64').toString();
                const sep = decoded.indexOf(':');
                method = decoded.slice(0, sep);
                password = decoded.slice(sep + 1);
            } catch {
                method = userinfo;
                password = decodeURIComponent(u.password);
            }
        }
        return {
            name,
            type: 'ss',
            server: u.hostname,
            port: parseInt(u.port),
            cipher: method,
            password,
            udp: true,
        };
    } catch {
        console.warn(`[Mihomo] 解析 ss 节点失败 (index=${index})`);
        return null;
    }
}

function parseHysteria2(url: string, index: number): ProxyNode | null {
    try {
        const u = new URL(url);
        const params = u.searchParams;
        const name = decodeURIComponent(u.hash.slice(1)) || `hy2-${index}`;
        return {
            name,
            type: 'hysteria2',
            server: u.hostname,
            port: parseInt(u.port),
            password: u.username || u.password,
            sni: params.get('sni') || u.hostname,
            'skip-cert-verify': params.get('insecure') === '1',
            udp: true,
        };
    } catch {
        console.warn(`[Mihomo] 解析 hysteria2 节点失败 (index=${index})`);
        return null;
    }
}

function parseNode(url: string, index: number): ProxyNode | null {
    if (url.startsWith('vless://')) return parseVless(url, index);
    if (url.startsWith('ss://')) return parseSS(url, index);
    if (url.startsWith('hysteria2://') || url.startsWith('hy2://')) return parseHysteria2(url, index);
    console.warn(`[Mihomo] 不支持的节点协议: ${url.slice(0, 20)}...`);
    return null;
}

// ==================== 配置生成 ====================

/**
 * 为第 workerIndex 个 Worker 生成 mihomo 配置
 * nodes 是分配给该 Worker 的节点子集，做 load-balance
 */
function generateMihomoConfig(nodes: ProxyNode[], port: number): object {
    const proxyNames = nodes.map(n => n.name);
    return {
        'mixed-port': port,
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'warning',
        proxies: nodes,
        'proxy-groups': [
            {
                name: 'PROXY',
                type: 'load-balance',
                proxies: proxyNames,
                url: 'http://www.gstatic.com/generate_204',
                interval: 300,
                strategy: 'round-robin',
            },
        ],
        rules: ['MATCH,PROXY'],
    };
}

// ==================== 子进程管理 ====================

async function fetchNodesFromSubscription(url: string): Promise<string[]> {
    console.log(`[Mihomo] 拉取订阅: ${url}`);
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`订阅请求失败: HTTP ${resp.status}`);
    const text = await resp.text();
    // 尝试 base64 解码
    let content = text.trim();
    try {
        const decoded = Buffer.from(content, 'base64').toString('utf-8');
        // 如果解码后包含 :// 则认为是 base64 编码的节点列表
        if (decoded.includes('://')) content = decoded;
    } catch { /* 不是 base64，直接用原文 */ }
    // 按行分割，过滤出节点链接
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes('://'));
    console.log(`[Mihomo] 订阅解析完成，共 ${lines.length} 个节点链接`);
    return lines;
}

/**
 * 从订阅/nodes 中过滤出 socks5:// 节点，返回代理 URL 列表
 * 供直连模式使用，不需要启动 mihomo
 */
export async function fetchSocks5Nodes(): Promise<string[]> {
    const config = getConfig();
    let nodeUrls: string[] = [];

    if (config.subscription) {
        try {
            nodeUrls = await fetchNodesFromSubscription(config.subscription);
        } catch (err) {
            console.error(`[Proxy] 订阅拉取失败: ${err}`);
            if (config.nodes && config.nodes.length > 0) {
                nodeUrls = config.nodes;
            }
        }
    } else if (config.nodes && config.nodes.length > 0) {
        nodeUrls = config.nodes;
    }

    const socks5Nodes = nodeUrls.filter(u => u.startsWith('socks5://'));
    console.log(`[Proxy] 订阅中共 ${nodeUrls.length} 个节点，其中 socks5 节点 ${socks5Nodes.length} 个`);
    return socks5Nodes;
}

const MIHOMO_PROBE_PORT = 7890;
const MIHOMO_CONTROLLER_PORT = 9090;

/**
 * 生成用于健康检查的临时 mihomo 配置（所有节点 + external-controller）
 */
function generateProbeConfig(nodes: ProxyNode[]): object {
    return {
        'mixed-port': MIHOMO_PROBE_PORT,
        'external-controller': `127.0.0.1:${MIHOMO_CONTROLLER_PORT}`,
        'allow-lan': false,
        mode: 'direct',
        'log-level': 'silent',
        proxies: nodes,
        'proxy-groups': [],
        rules: [],
    };
}

/**
 * 启动临时 mihomo 进程做健康检查，返回按延迟排序的可用节点列表
 */
async function probeNodes(mihomoBin: string, nodes: ProxyNode[]): Promise<ProxyNode[]> {
    if (!existsSync(MIHOMO_CONFIG_DIR)) {
        mkdirSync(MIHOMO_CONFIG_DIR, { recursive: true });
    }
    const probePath = join(MIHOMO_CONFIG_DIR, 'probe.yaml');
    writeFileSync(probePath, yamlStringify(generateProbeConfig(nodes)), 'utf-8');

    const proc = spawn(mihomoBin, ['-f', probePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 等待 mihomo 启动
    await new Promise(r => setTimeout(r, 1500));

    const baseUrl = `http://127.0.0.1:${MIHOMO_CONTROLLER_PORT}`;
    const testUrl = 'http://www.gstatic.com/generate_204';
    const timeout = 5000;

    console.log(`[Mihomo] 开始探测 ${nodes.length} 个节点延迟...`);

    // 并发探测所有节点
    const results = await Promise.all(
        nodes.map(async (node) => {
            try {
                const resp = await fetch(
                    `${baseUrl}/proxies/${encodeURIComponent(node.name)}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`,
                    { signal: AbortSignal.timeout(timeout + 2000) }
                );
                if (!resp.ok) return { node, delay: Infinity };
                const json = await resp.json() as { delay?: number };
                return { node, delay: json.delay ?? Infinity };
            } catch {
                return { node, delay: Infinity };
            }
        })
    );

    // 停止临时进程
    proc.removeAllListeners('exit');
    proc.kill();

    const available = results
        .filter(r => r.delay < Infinity)
        .sort((a, b) => a.delay - b.delay);

    console.log(`[Mihomo] 探测完成：${available.length}/${nodes.length} 个节点可用`);
    if (available.length > 0) {
        const top5 = available.slice(0, 5).map(r => `${r.node.name}(${r.delay}ms)`).join(', ');
        console.log(`[Mihomo] 最优节点: ${top5}`);
    }

    return available.map(r => r.node);
}

function spawnMihomoProcess(mihomoBin: string, configPath: string, workerIndex: number): ChildProcess {
    const proc = spawn(mihomoBin, ['-f', configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) console.log(`[Mihomo-${workerIndex}] ${line}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) console.log(`[Mihomo-${workerIndex}] ${line}`);
    });
    proc.on('exit', (code) => {
        console.warn(`[Mihomo-${workerIndex}] 进程退出 code=${code}，5s 后重启...`);
        setTimeout(() => {
            mihomoProcesses[workerIndex] = spawnMihomoProcess(mihomoBin, configPath, workerIndex);
        }, 5000);
    });
    return proc;
}

/**
 * 启动多个 mihomo 进程，每个 Worker 独占一个进程和端口
 * 节点均分给各进程做 load-balance
 * 返回启动的进程数（即 Worker 数量上限）
 */
export async function startMihomo(workerCount: number): Promise<number> {
    const config = getConfig();
    const hasSubscription = !!config.subscription;
    const hasNodes = !!(config.nodes && config.nodes.length > 0);
    if (!hasSubscription && !hasNodes) return 0;

    // 获取节点链接列表
    let nodeUrls: string[] = [];
    if (hasSubscription) {
        try {
            nodeUrls = await fetchNodesFromSubscription(config.subscription!);
        } catch (err) {
            console.error(`[Mihomo] 订阅拉取失败: ${err}`);
            if (hasNodes) {
                console.log('[Mihomo] 降级使用 config.yaml 中的 nodes 列表');
                nodeUrls = config.nodes!;
            } else {
                return 0;
            }
        }
    } else {
        nodeUrls = config.nodes!;
    }

    const parsedNodes = nodeUrls
        .map((url, i) => parseNode(url, i))
        .filter((n): n is ProxyNode => n !== null);

    if (parsedNodes.length === 0) {
        console.warn('[Mihomo] 没有可用节点，跳过启动');
        return 0;
    }

    const mihomoBin = getMihomoBin();
    console.log(`[Mihomo] 使用可执行文件: ${mihomoBin}`);
    console.log(`[Mihomo] 共解析 ${parsedNodes.length} 个节点，开始健康检查...`);

    // 健康检查：过滤不可用节点，按延迟排序
    const allNodes = await probeNodes(mihomoBin, parsedNodes);

    if (allNodes.length === 0) {
        console.warn('[Mihomo] 所有节点均不可用，跳过启动');
        return 0;
    }

    // 实际启动的进程数：不超过可用节点数也不超过 workerCount
    const instanceCount = Math.min(workerCount, allNodes.length);

    if (!existsSync(MIHOMO_CONFIG_DIR)) {
        mkdirSync(MIHOMO_CONFIG_DIR, { recursive: true });
    }

    console.log(`[Mihomo] 共 ${allNodes.length} 个可用节点，启动 ${instanceCount} 个进程`);

    for (let i = 0; i < instanceCount; i++) {
        // 均分节点给每个实例
        const slice: ProxyNode[] = [];
        for (let j = i; j < allNodes.length; j += instanceCount) {
            slice.push(allNodes[j]);
        }
        const port = MIHOMO_BASE_PORT + i;
        const configPath = join(MIHOMO_CONFIG_DIR, `config-${i}.yaml`);
        writeFileSync(configPath, yamlStringify(generateMihomoConfig(slice, port)), 'utf-8');
        mihomoProcesses[i] = spawnMihomoProcess(mihomoBin, configPath, i);
        console.log(`[Mihomo-${i}] 端口 ${port}，分配 ${slice.length} 个节点`);
    }

    // 等待所有实例启动就绪
    await new Promise(r => setTimeout(r, 2000));
    console.log(`[Mihomo] 全部启动完成，端口 ${MIHOMO_BASE_PORT}-${MIHOMO_BASE_PORT + instanceCount - 1}`);
    return instanceCount;
}

export function stopMihomo(): void {
    for (const proc of mihomoProcesses) {
        if (proc) {
            proc.removeAllListeners('exit');
            proc.kill();
        }
    }
    mihomoProcesses.length = 0;
}

