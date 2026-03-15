/**
 * test-toolcalls.mjs - 全面测试工具调用，验证 Claude Code CLI 不会收到纯文本
 *
 * 测试场景:
 * 1. 单个工具调用（Read）
 * 2. 多工具并行调用
 * 3. 工具调用链（multi-turn）
 * 4. Write 工具（大内容）
 * 5. tool_choice=any 强制工具调用
 * 6. tool_choice=tool 指定工具
 * 7. 工具结果回传后继续调用
 * 8. 复杂嵌套参数
 * 9. 带系统提示词的工具调用
 * 10. Bash 工具调用
 */

const BASE_URL = 'http://localhost:3020';
const MODEL = 'claude-sonnet-4-6';

const TOOLS = [
    {
        name: 'Read',
        description: 'Read a file from the filesystem',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to file' },
            },
            required: ['file_path'],
        },
    },
    {
        name: 'Write',
        description: 'Write content to a file',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to file' },
                content: { type: 'string', description: 'Content to write' },
            },
            required: ['file_path', 'content'],
        },
    },
    {
        name: 'Bash',
        description: 'Run a bash command',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run' },
                timeout: { type: 'number', description: 'Timeout in ms' },
            },
            required: ['command'],
        },
    },
    {
        name: 'Edit',
        description: 'Edit a file by replacing text',
        input_schema: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Absolute path to file' },
                old_string: { type: 'string', description: 'Text to replace' },
                new_string: { type: 'string', description: 'Replacement text' },
            },
            required: ['file_path', 'old_string', 'new_string'],
        },
    },
    {
        name: 'Glob',
        description: 'Find files matching a pattern',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Glob pattern' },
                path: { type: 'string', description: 'Directory to search' },
            },
            required: ['pattern'],
        },
    },
];

async function callAPI(messages, tools, opts = {}) {
    const body = {
        model: MODEL,
        max_tokens: opts.max_tokens || 2048,
        messages,
        stream: opts.stream || false,
    };
    if (tools) body.tools = tools;
    if (opts.tool_choice) body.tool_choice = opts.tool_choice;
    if (opts.system) body.system = opts.system;

    const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
    }

    if (opts.stream) {
        return parseSSE(await res.text());
    }

    return await res.json();
}

function parseSSE(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trimStart().startsWith('data:'));
    const result = { tool_calls: [], text: '', stop_reason: null };
    for (const line of lines) {
        try {
            const data = JSON.parse(line.slice(5));
            if (data.type === 'content_block_delta') {
                if (data.delta?.type === 'text_delta') result.text += data.delta.text;
                if (data.delta?.type === 'input_json_delta') {
                    if (!result._partials) result._partials = {};
                    result._partials[data.index] = (result._partials[data.index] || '') + data.delta.partial_json;
                }
            }
            if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                result.tool_calls.push({ index: data.index, name: data.content_block.name, input: null });
            }
            if (data.type === 'message_delta') result.stop_reason = data.delta?.stop_reason;
        } catch {}
    }
    // resolve partial JSON
    if (result._partials) {
        for (const tc of result.tool_calls) {
            const partial = result._partials[tc.index];
            if (partial) {
                try { tc.input = JSON.parse(partial); } catch { tc.input = partial; }
            }
        }
    }
    return result;
}

function extractToolCalls(response) {
    if (!response.content) return [];
    return response.content.filter(b => b.type === 'tool_use');
}

function extractText(response) {
    if (!response.content) return '';
    return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

let passed = 0;
let failed = 0;
const results = [];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test(name, fn) {
    await sleep(1500);
    process.stdout.write(`${name}\
  running...`);
    try {
        const result = await fn();
        if (result.pass) {
            console.log(` ✅ PASS`);
            if (result.detail) console.log(`  ${result.detail}`);
            passed++;
            results.push({ name, pass: true, detail: result.detail });
        } else {
            console.log(` ❌ FAIL`);
            console.log(`  ${result.reason}`);
            failed++;
            results.push({ name, pass: false, reason: result.reason });
        }
    } catch (e) {
        console.log(` ⚠️  ERROR: ${e.message}`);
        failed++;
        results.push({ name, pass: false, reason: e.message });
    }
    console.log();
}

const TOOLS_SUBSET = TOOLS.slice(0, 3); // Read, Write, Bash

console.log(`测试目标: ${BASE_URL}`);
console.log(`模型: ${MODEL}`);
console.log('='.repeat(60));

// ========== TEST 1: 单工具调用 ==========
await test('1. 单工具调用 - Read文件', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Read the file /etc/hostname' }],
        [TOOLS[0]], // Read only
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无工具调用，纯文本: ${text.substring(0, 150)}` };
    }
    const tc = tools[0];
    return { pass: true, detail: `tool=${tc.name}, input=${JSON.stringify(tc.input)}` };
});

// ========== TEST 2: Bash工具调用 ==========
await test('2. Bash工具调用 - 运行命令', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Run `ls -la /tmp` to list files' }],
        [TOOLS[2]], // Bash only
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无工具调用，纯文本: ${text.substring(0, 150)}` };
    }
    const tc = tools[0];
    return { pass: true, detail: `tool=${tc.name}, command=${tc.input?.command}` };
});

// ========== TEST 3: 多工具并行 ==========
await test('3. 多工具并行调用', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Read /etc/hostname AND run `pwd` in parallel, then show both results' }],
        TOOLS_SUBSET,
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无工具调用，纯文本: ${text.substring(0, 150)}` };
    }
    return { pass: true, detail: `${tools.length}个工具调用: ${tools.map(t => t.name).join(', ')}` };
});

// ========== TEST 4: tool_choice=any ==========
await test('4. tool_choice=any 强制工具调用', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'What is 2+2?' }],
        TOOLS_SUBSET,
        { tool_choice: { type: 'any' } },
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `tool_choice=any 但无工具调用，纯文本: ${text.substring(0, 150)}` };
    }
    return { pass: true, detail: `强制工具: ${tools.map(t => t.name).join(', ')}` };
});

// ========== TEST 5: tool_choice=tool 指定工具 ==========
await test('5. tool_choice=tool 指定Bash', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Check disk space' }],
        TOOLS_SUBSET,
        { tool_choice: { type: 'tool', name: 'Bash' } },
    );
    const tools = extractToolCalls(resp);
    const bashCalls = tools.filter(t => t.name === 'Bash');
    if (bashCalls.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `未调用Bash，tools=${tools.map(t=>t.name).join(',')}, text: ${text.substring(0, 100)}` };
    }
    return { pass: true, detail: `Bash command: ${bashCalls[0].input?.command}` };
});

// ========== TEST 6: 工具结果回传 multi-turn ==========
await test('6. 工具结果回传 multi-turn', async () => {
    // Turn 1: 请求工具调用
    const resp1 = await callAPI(
        [{ role: 'user', content: 'Read /etc/hostname to get the hostname' }],
        [TOOLS[0]],
    );
    const tools1 = extractToolCalls(resp1);
    if (tools1.length === 0) {
        return { pass: false, reason: `第1轮无工具调用: ${extractText(resp1).substring(0, 100)}` };
    }

    // Turn 2: 提供工具结果，请求继续
    const messages2 = [
        { role: 'user', content: 'Read /etc/hostname to get the hostname' },
        { role: 'assistant', content: resp1.content },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: tools1[0].id,
                    content: 'myserver.local',
                },
            ],
        },
    ];
    const resp2 = await callAPI(messages2, [TOOLS[0]]);
    const text2 = extractText(resp2);
    const tools2 = extractToolCalls(resp2);
    // 成功条件：第2轮要么有更多工具调用，要么有包含 hostname 的文本响应
    const hasResult = text2.length > 0 || tools2.length > 0;
    if (!hasResult) {
        return { pass: false, reason: `第2轮无响应` };
    }
    return { pass: true, detail: `第2轮: ${tools2.length}工具调用, 文本=${text2.substring(0, 80)}` };
});

// ========== TEST 7: Write工具大内容 ==========
await test('7. Write工具 - 大内容（100行代码）', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Write a TypeScript file at /tmp/test.ts containing a complete Express server with 5 routes (GET /, GET /health, POST /api/users, GET /api/users/:id, DELETE /api/users/:id). Include proper TypeScript types and error handling.' }],
        [TOOLS[0], TOOLS[1], TOOLS[2]], // Read, Write, Bash
    );
    const tools = extractToolCalls(resp);
    const writeCalls = tools.filter(t => t.name === 'Write');
    if (writeCalls.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无Write调用，纯文本长度=${text.length}: ${text.substring(0, 150)}` };
    }
    const content = writeCalls[0].input?.content || '';
    return { pass: true, detail: `Write content ${content.length} chars, file=${writeCalls[0].input?.file_path}` };
});

// ========== TEST 8: 流式工具调用 ==========
await test('8. 流式工具调用', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Read the file /etc/hostname' }],
        [TOOLS[0]],
        { stream: true },
    );
    if (!resp.tool_calls || resp.tool_calls.length === 0) {
        return { pass: false, reason: `流式无工具调用，文本: ${resp.text?.substring(0, 150)}` };
    }
    const tc = resp.tool_calls[0];
    return { pass: true, detail: `流式tool=${tc.name}, stop_reason=${resp.stop_reason}` };
});

// ========== TEST 9: 带系统提示词的工具调用 ==========
await test('9. 带系统提示词的工具调用', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'List all TypeScript files in the current project' }],
        [TOOLS[0], TOOLS[4]], // Read, Glob
        { system: 'You are a helpful coding assistant. Always use tools to complete tasks.' },
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无工具调用，纯文本: ${text.substring(0, 150)}` };
    }
    return { pass: true, detail: `tools=${tools.map(t=>t.name).join(', ')}` };
});

// ========== TEST 10: Edit工具 ==========
await test('10. Edit工具调用', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Edit the file /tmp/test.ts: the file contains `console.error("[error]", err.message);` — replace `console.error` with `logger.error` using the Edit tool.' }],
        [TOOLS[3]], // Edit only
    );
    const tools = extractToolCalls(resp);
    const editCalls = tools.filter(t => t.name === 'Edit');
    if (editCalls.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无Edit调用，纯文本: ${text.substring(0, 150)}` };
    }
    return { pass: true, detail: `Edit: old=${editCalls[0].input?.old_string?.substring(0,30)}, new=${editCalls[0].input?.new_string?.substring(0,30)}` };
});

// ========== TEST 11: 复杂多轮 tool chain ==========
await test('11. 复杂多轮工具链（Bash -> Read -> Write）', async () => {
    // 模拟 Claude Code 的典型工作流：先查看，再修改
    const resp1 = await callAPI(
        [{ role: 'user', content: 'First run `ls /tmp` to see what files exist' }],
        TOOLS_SUBSET,
    );
    const tools1 = extractToolCalls(resp1);
    if (tools1.length === 0) {
        return { pass: false, reason: `第1轮无工具调用: ${extractText(resp1).substring(0, 100)}` };
    }

    // 模拟工具结果
    const messages2 = [
        { role: 'user', content: 'First run `ls /tmp` to see what files exist' },
        { role: 'assistant', content: resp1.content },
        {
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: tools1[0].id,
                content: 'test.ts\ntest2.ts\napp.log',
            }],
        },
    ];
    const resp2 = await callAPI(messages2, TOOLS_SUBSET);
    const tools2 = extractToolCalls(resp2);
    const text2 = extractText(resp2);
    const hasNext = tools2.length > 0 || text2.length > 10;
    if (!hasNext) {
        return { pass: false, reason: `第2轮无响应` };
    }
    return { pass: true, detail: `链式: 第1轮tool=${tools1[0].name}, 第2轮tools=${tools2.map(t=>t.name).join(',') || 'text:'+text2.substring(0,50)}` };
});

// ========== TEST 12: Glob工具 ==========
await test('12. Glob工具 - 查找文件', async () => {
    const resp = await callAPI(
        [{ role: 'user', content: 'Find all .ts files in /tmp directory' }],
        [TOOLS[4]], // Glob
    );
    const tools = extractToolCalls(resp);
    if (tools.length === 0) {
        const text = extractText(resp);
        return { pass: false, reason: `无Glob调用，纯文本: ${text.substring(0, 150)}` };
    }
    return { pass: true, detail: `Glob pattern=${tools[0].input?.pattern}` };
});

// ========== SUMMARY ==========
console.log('='.repeat(60));
console.log(`结果: ${passed} 通过, ${failed} 失败`);
console.log();
if (failed > 0) {
    console.log('失败详情:');
    for (const r of results.filter(r => !r.pass)) {
        console.log(`  ❌ ${r.name}: ${r.reason}`);
    }
}
