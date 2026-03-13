#!/usr/bin/env node
// 测试模型端点 - 50并发请求
const CONCURRENCY = parseInt(process.argv[2]) || 10;
const TOTAL = parseInt(process.argv[3]) || 50;
const PORT = parseInt(process.argv[4]) || 3010;
const BASE_URL = 'http://localhost:' + PORT;

const PAYLOAD = {
    model: 'anthropic/claude-sonnet-4.6',
    stream: false,
    max_tokens: 1024,
    messages: [
        {
            role: 'user',
            content: '用 Python 实现快速排序并分析时间复杂度（最好、最坏、平均情况），给出代码注释和复杂度推导过程。'
        }
    ]
};

async function singleRequest(index) {
    const start = Date.now();
    try {
        const res = await fetch(BASE_URL + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(PAYLOAD)
        });
        const ms = Date.now() - start;
        if (!res.ok) {
            const text = await res.text();
            return { index, ok: false, ms, status: res.status, err: text.slice(0, 100) };
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || '';
        return { index, ok: true, ms, chars: content.length, preview: content.slice(0, 60) };
    } catch (err) {
        const ms = Date.now() - start;
        return { index, ok: false, ms, err: err.message };
    }
}

async function main() {
    console.log('=== 模型端点并发测试 ===');
    console.log('目标: ' + BASE_URL + '/v1/chat/completions');
    console.log('并发数: ' + CONCURRENCY + ', 总请求数: ' + TOTAL);
    console.log('Prompt: 用 Python 实现快速排序并分析时间复杂度');
    console.log('');

    const results = [];
    let completed = 0;

    const allStart = Date.now();

    for (let i = 0; i < TOTAL; i += CONCURRENCY) {
        const batch = [];
        for (let j = i; j < Math.min(i + CONCURRENCY, TOTAL); j++) {
            batch.push(singleRequest(j));
        }
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        completed += batchResults.length;
        const ok = results.filter(r => r.ok).length;
        process.stdout.write('\r进度: ' + completed + '/' + TOTAL + '  成功: ' + ok);
    }

    const totalMs = Date.now() - allStart;
    console.log('\n');

    const ok = results.filter(r => r.ok);
    const fail = results.filter(r => !r.ok);
    const latencies = ok.map(r => r.ms).sort((a, b) => a - b);

    console.log('=== 结果统计 ===');
    console.log('总请求: ' + TOTAL + ', 成功: ' + ok.length + ', 失败: ' + fail.length);
    console.log('总耗时: ' + (totalMs / 1000).toFixed(1) + 's');

    if (latencies.length > 0) {
        const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        console.log('延迟 (ms): avg=' + avg + '  p50=' + p50 + '  p95=' + p95 + '  p99=' + p99 + '  min=' + latencies[0] + '  max=' + latencies[latencies.length - 1]);

        const avgChars = Math.round(ok.reduce((a, r) => a + (r.chars || 0), 0) / ok.length);
        console.log('平均响应长度: ' + avgChars + ' 字符');
    }

    if (fail.length > 0) {
        console.log('\n失败详情:');
        for (const r of fail.slice(0, 5)) {
            console.log('  [' + r.index + '] status=' + (r.status || 'err') + ' err=' + r.err);
        }
        if (fail.length > 5) console.log('  ... 共 ' + fail.length + ' 个失败');
    }

    console.log('\n响应预览（前3个成功）:');
    for (const r of ok.slice(0, 3)) {
        console.log('  [' + r.index + '] ' + r.ms + 'ms | ' + r.preview + '...');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
