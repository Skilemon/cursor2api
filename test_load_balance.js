#!/usr/bin/env node
const CONCURRENCY = parseInt(process.argv[2]) || 10;
const TOTAL = parseInt(process.argv[3]) || 50;
const PORT = parseInt(process.argv[4]) || 3010;
const BASE_URL = 'http://localhost:' + PORT;

async function singleRequest(index) {
    const start = Date.now();
    try {
        const res = await fetch(BASE_URL + '/health');
        const data = await res.json();
        const ms = Date.now() - start;
        return { index, pid: data.pid, ms, ok: true };
    } catch (err) {
        const ms = Date.now() - start;
        return { index, pid: null, ms, ok: false, err: err.message };
    }
}

async function main() {
    console.log('=== 并发负载均衡测试 ===');
    console.log('目标: ' + BASE_URL);
    console.log('并发数: ' + CONCURRENCY + ', 总请求数: ' + TOTAL);
    console.log('');

    try {
        const res = await fetch(BASE_URL + '/health');
        const data = await res.json();
        console.log('服务正常, 示例 PID: ' + data.pid);
    } catch (err) {
        console.error('无法连接到 ' + BASE_URL + ', 请确认服务已启动。');
        console.error(err.message);
        process.exit(1);
    }

    const results = [];
    let completed = 0;

    for (let i = 0; i < TOTAL; i += CONCURRENCY) {
        const batch = [];
        for (let j = i; j < Math.min(i + CONCURRENCY, TOTAL); j++) {
            batch.push(singleRequest(j));
        }
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        completed += batchResults.length;
        process.stdout.write('\r进度: ' + completed + '/' + TOTAL);
    }

    console.log('\n');

    const pidMap = {};
    let failed = 0;
    const latencies = [];

    for (const r of results) {
        if (!r.ok) { failed++; continue; }
        latencies.push(r.ms);
        const key = String(r.pid);
        pidMap[key] = (pidMap[key] || 0) + 1;
    }

    const succeeded = results.length - failed;
    const pids = Object.keys(pidMap).sort();

    console.log('=== 结果统计 ===');
    console.log('总请求: ' + TOTAL + ', 成功: ' + succeeded + ', 失败: ' + failed);
    console.log('Worker 种类 (PID): ' + pids.length);
    console.log('');

    if (pids.length === 0) {
        console.log('无成功请求，无法统计分布。');
        return;
    }

    console.log('Worker 分布:');
    const maxCount = Math.max(...Object.values(pidMap));
    for (const pid of pids) {
        const count = pidMap[pid];
        const pct = ((count / succeeded) * 100).toFixed(1);
        const barLen = Math.round((count / maxCount) * 20);
        const bar = '#'.repeat(barLen).padEnd(20);
        console.log('  PID ' + pid.padEnd(8) + ' [' + bar + '] ' + count + ' 次 (' + pct + '%)');
    }

    if (latencies.length > 0) {
        latencies.sort((a, b) => a - b);
        const avg = (latencies.reduce((s, v) => s + v, 0) / latencies.length).toFixed(1);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        console.log('');
        console.log('延迟 (ms): avg=' + avg + '  p50=' + p50 + '  p95=' + p95 + '  p99=' + p99 + '  min=' + latencies[0] + '  max=' + latencies[latencies.length - 1]);
    }

    if (pids.length > 1) {
        const counts = Object.values(pidMap);
        const avg = succeeded / pids.length;
        const maxDev = Math.max(...counts.map(c => Math.abs(c - avg) / avg));
        console.log('');
        console.log('均衡度: 最大偏差 ' + (maxDev * 100).toFixed(1) + '%');
        if (maxDev <= 0.2) {
            console.log('结论: 负载均衡良好 (偏差 <= 20%)');
        } else if (maxDev <= 0.5) {
            console.log('结论: 负载均衡一般 (偏差 20%~50%)');
        } else {
            console.log('结论: 负载不均衡 (偏差 > 50%), 可能存在问题');
        }
    } else {
        console.log('');
        console.log('警告: 所有请求落到同一个 Worker, 负载均衡未生效。');
        console.log('  请确认 workers 配置 > 1 且服务正常启动了多个进程。');
    }

    console.log('');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
