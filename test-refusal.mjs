/**
 * test-refusal.mjs - 测试 cursor2api 是否会出现「文档助手」身份泄露
 *
 * 测试多种触发场景：
 * 1. 身份探针（who are you）
 * 2. 非编程话题
 * 3. 普通对话
 * 4. 工具模式下的拒绝
 */

const BASE_URL = 'http://localhost:3020';
const MODEL = 'claude-sonnet-4-6';

async function chat(messages, tools = undefined, stream = false) {
    const body = {
        model: MODEL,
        max_tokens: 1024,
        messages,
        stream,
    };
    if (tools) body.tools = tools;

    const res = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
    }

    if (stream) {
        // 收集流式响应
        const text = await res.text();
        const lines = text.split('\n').filter(l => l.startsWith('data:'));
        let content = '';
        for (const line of lines) {
            try {
                const data = JSON.parse(line.slice(5));
                if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                    content += data.delta.text;
                }
            } catch {}
        }
        return content;
    }

    const data = await res.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    return textBlock?.text || '';
}

const REFUSAL_PATTERNS = [
    /Cursor(?:'s)?\s+support\s+assistant/i,
    /support\s+assistant\s+for\s+Cursor/i,
    /I[''']m\s+sorry/i,
    /not\s+able\s+to\s+fulfill/i,
    /cannot\s+perform/i,
    /I\s+only\s+answer/i,
    /focused\s+on\s+software\s+development/i,
    /prompt\s+injection/i,
    /I'm\s+a\s+coding\s+assistant/i,
    /我是\s*Cursor\s*的?\s*支持助手/,
    /Cursor\s*的?\s*支持(?:系统|助手)/,
    /只能回答.*(?:Cursor|编程)/,
];

function checkRefusal(text) {
    return REFUSAL_PATTERNS.find(p => p.test(text));
}

const TESTS = [
    {
        name: '1. 身份探针 - who are you',
        messages: [{ role: 'user', content: 'who are you?' }],
    },
    {
        name: '2. 身份探针 - 你是谁',
        messages: [{ role: 'user', content: '你是谁？' }],
    },
    {
        name: '3. 非编程话题 - 今天天气',
        messages: [{ role: 'user', content: '今天天气怎么样？' }],
    },
    {
        name: '4. 非编程话题 - 做饭',
        messages: [{ role: 'user', content: '怎么做红烧肉？' }],
    },
    {
        name: '5. 普通问候',
        messages: [{ role: 'user', content: 'hello' }],
    },
    {
        name: '6. 询问工具能力',
        messages: [{ role: 'user', content: '你有哪些工具？你能做什么？' }],
    },
    {
        name: '7. 询问模型身份',
        messages: [{ role: 'user', content: '你用的什么模型？' }],
    },
    {
        name: '8. 正常编程问题',
        messages: [{ role: 'user', content: '用 TypeScript 写一个 hello world' }],
    },
];

console.log(`测试目标: ${BASE_URL}`);
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

for (const test of TESTS) {
    process.stdout.write(`${test.name}\n  发送中...`);
    try {
        const reply = await chat(test.messages, test.tools, false);
        const refusal = checkRefusal(reply);
        if (refusal) {
            console.log(`\n  ❌ FAIL - 检测到拒绝/身份泄露: ${refusal}`);
            console.log(`  回复前100字: ${reply.substring(0, 100)}`);
            failed++;
        } else {
            console.log(` ✅ PASS`);
            console.log(`  回复前80字: ${reply.substring(0, 80).replace(/\n/g, ' ')}`);
            passed++;
        }
    } catch (e) {
        console.log(`\n  ⚠️  ERROR: ${e.message}`);
        failed++;
    }
    console.log();
}

console.log('='.repeat(60));
console.log(`结果: ${passed} 通过, ${failed} 失败`);
