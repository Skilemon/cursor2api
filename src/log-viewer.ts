/**
 * log-viewer.ts - 全链路日志 Web UI v3
 * 
 * 核心特性：
 * - 完整请求参数查看（原始请求 body, messages, tools）
 * - 提示词查看（system prompt, 用户消息）
 * - 模型返回内容查看（原始响应, 最终响应, thinking, tool calls）
 * - 阶段耗时时间线
 * - 重试/续写历史
 * - 实时 SSE + 搜索 + 过滤
 */

import type { Request, Response } from 'express';
import { getAllLogs, getRequestSummaries, getStats, getRequestPayload, subscribeToLogs, subscribeToSummaries } from './logger.js';

// ==================== API 路由 ====================

export function apiGetLogs(req: Request, res: Response): void {
    const { requestId, level, source, limit, since } = req.query;
    res.json(getAllLogs({
        requestId: requestId as string, level: level as any, source: source as any,
        limit: limit ? parseInt(limit as string) : 200,
        since: since ? parseInt(since as string) : undefined,
    }));
}

export function apiGetRequests(req: Request, res: Response): void {
    res.json(getRequestSummaries(req.query.limit ? parseInt(req.query.limit as string) : 50));
}

export function apiGetStats(_req: Request, res: Response): void {
    res.json(getStats());
}

/** GET /api/payload/:requestId - 获取请求的完整参数和响应 */
export function apiGetPayload(req: Request, res: Response): void {
    const payload = getRequestPayload(req.params.requestId as string);
    if (!payload) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(payload);
}

export function apiLogsStream(req: Request, res: Response): void {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const sse = (event: string, data: string) => 'event: ' + event + '\ndata: ' + data + '\n\n';
    try { res.write(sse('stats', JSON.stringify(getStats()))); } catch { /**/ }
    const unsubLog = subscribeToLogs(e => { try { res.write(sse('log', JSON.stringify(e))); } catch { /**/ } });
    const unsubSummary = subscribeToSummaries(s => {
        try { res.write(sse('summary', JSON.stringify(s))); res.write(sse('stats', JSON.stringify(getStats()))); } catch { /**/ }
    });
    const hb = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /**/ } }, 15000);
    req.on('close', () => { unsubLog(); unsubSummary(); clearInterval(hb); });
}

export function serveLogViewer(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(LOG_VIEWER_HTML);
}

export function serveLogViewerLogin(_req: Request, res: Response): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(LOGIN_HTML);
}

// ==================== Login Page HTML ====================

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cursor2API - 登录</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#080c14;color:#e2e8f0;height:100vh;display:flex;align-items:center;justify-content:center}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(600px 400px at 50% 40%,rgba(59,130,246,.08),transparent 70%),radial-gradient(400px 300px at 70% 70%,rgba(139,92,246,.06),transparent 70%);pointer-events:none}
.card{position:relative;z-index:1;width:380px;padding:40px;background:rgba(15,21,32,.95);border:1px solid rgba(30,58,95,.6);border-radius:16px;backdrop-filter:blur(20px);box-shadow:0 25px 50px rgba(0,0,0,.4)}
.logo{text-align:center;margin-bottom:28px}
.logo h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,#06b6d4,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.logo p{font-size:12px;color:#64748b;margin-top:6px}
.field{margin-bottom:20px}
.field label{display:block;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.field input{width:100%;padding:10px 14px;font-size:13px;background:#0f1520;border:1px solid #1e3a5f;border-radius:8px;color:#e2e8f0;outline:none;font-family:'JetBrains Mono',monospace;transition:border-color .2s}
.field input:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.field input::placeholder{color:#475569}
.btn{width:100%;padding:10px;font-size:13px;font-weight:600;background:linear-gradient(135deg,#3b82f6,#8b5cf6);border:none;border-radius:8px;color:#fff;cursor:pointer;transition:opacity .2s,transform .1s}
.btn:hover{opacity:.9}.btn:active{transform:scale(.98)}
.err{margin-top:12px;padding:8px 12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);border-radius:6px;font-size:11px;color:#ef4444;display:none;text-align:center}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>⚡ Cursor2API</h1>
    <p>日志查看器需要验证身份</p>
  </div>
  <div class="field">
    <label>Auth Token</label>
    <input type="password" id="tokenIn" placeholder="sk-your-token..." autofocus />
  </div>
  <button class="btn" onclick="doLogin()">登录</button>
  <div class="err" id="errMsg">Token 无效，请检查后重试</div>
</div>
<script>
// 检查 localStorage 是否已有 token，自动尝试登录
const saved = localStorage.getItem('cursor2api_token');
if (saved) {
  window.location.href = '/logs?token=' + encodeURIComponent(saved);
}
document.getElementById('tokenIn').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const token = document.getElementById('tokenIn').value.trim();
  if (!token) return;
  try {
    const r = await fetch('/api/stats?token=' + encodeURIComponent(token));
    if (r.ok) {
      localStorage.setItem('cursor2api_token', token);
      window.location.href = '/logs?token=' + encodeURIComponent(token);
    } else {
      document.getElementById('errMsg').style.display = 'block';
    }
  } catch {
    document.getElementById('errMsg').style.display = 'block';
  }
}
</script>
</body>
</html>`;

// ==================== HTML ====================

const LOG_VIEWER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cursor2API - 全链路日志</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg0:#080c14;--bg1:#0f1520;--bg2:#161e2e;--bg3:#1c2740;--bg-card:#131b2a;--bdr:#1e3a5f;--bdr2:#2d4a6f;--t1:#e2e8f0;--t2:#94a3b8;--t3:#64748b;--blue:#3b82f6;--cyan:#06b6d4;--green:#10b981;--yellow:#f59e0b;--red:#ef4444;--purple:#8b5cf6;--pink:#ec4899;--orange:#f97316;--mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--sans);background:var(--bg0);color:var(--t1);height:100vh;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(600px 400px at 15% 15%,rgba(59,130,246,.06),transparent 70%),radial-gradient(500px 350px at 85% 80%,rgba(139,92,246,.04),transparent 70%);pointer-events:none;z-index:0}
.app{display:flex;flex-direction:column;height:100vh;position:relative;z-index:1}

/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--bdr);background:rgba(15,21,32,.9);backdrop-filter:blur(12px)}
.hdr h1{font-size:15px;font-weight:700;background:linear-gradient(135deg,var(--cyan),var(--blue),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:flex;align-items:center;gap:6px}
.hdr h1 .ic{font-size:16px;-webkit-text-fill-color:initial}
.hdr-stats{display:flex;gap:10px}
.sc{padding:3px 10px;background:rgba(255,255,255,.03);border:1px solid var(--bdr);border-radius:6px;font-size:11px;color:var(--t2);display:flex;align-items:center;gap:4px}
.sc b{font-family:var(--mono);color:var(--t1);font-weight:600}
.hdr-r{display:flex;gap:8px;align-items:center}
.conn{display:flex;align-items:center;gap:4px;font-size:10px;padding:2px 8px;border-radius:12px;border:1px solid var(--bdr)}
.conn.on{color:var(--green);border-color:rgba(16,185,129,.3)}.conn.off{color:var(--red);border-color:rgba(239,68,68,.3)}
.conn .d{width:5px;height:5px;border-radius:50%}
.conn.on .d{background:var(--green);animation:p 2s infinite}.conn.off .d{background:var(--red)}
@keyframes p{0%,100%{opacity:1}50%{opacity:.3}}

/* Main */
.main{display:flex;flex:1;overflow:hidden}

/* Sidebar */
.side{width:360px;border-right:1px solid var(--bdr);display:flex;flex-direction:column;background:var(--bg1);flex-shrink:0}
.search{padding:6px 10px;border-bottom:1px solid var(--bdr)}
.sw{position:relative}.sw::before{content:'🔍';position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:11px;pointer-events:none}
.si{width:100%;padding:6px 10px 6px 28px;font-size:11px;background:var(--bg0);border:1px solid var(--bdr);border-radius:6px;color:var(--t1);outline:none;font-family:var(--mono)}
.si:focus{border-color:var(--blue)}.si::placeholder{color:var(--t3)}
.fbar{padding:5px 8px;border-bottom:1px solid var(--bdr);display:flex;gap:3px;flex-wrap:wrap}
.fb{padding:2px 7px;font-size:10px;font-weight:500;border:1px solid var(--bdr);border-radius:14px;background:transparent;color:var(--t2);cursor:pointer;transition:.2s;display:flex;align-items:center;gap:3px}
.fb:hover{border-color:var(--blue);color:var(--blue)}.fb.a{background:var(--blue);border-color:var(--blue);color:#fff}
.fc{font-size:8px;font-weight:600;padding:0 4px;border-radius:8px;background:rgba(255,255,255,.12);min-width:14px;text-align:center}
.fb.a .fc{background:rgba(255,255,255,.2)}
.rlist{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--bdr) transparent}
.ri{padding:8px 12px;border-bottom:1px solid rgba(30,58,95,.2);cursor:pointer;transition:.15s;position:relative}
.ri:hover{background:var(--bg3)}.ri.a{background:rgba(59,130,246,.1);border-left:3px solid var(--blue)}
.ri .si-dot{position:absolute;right:8px;top:8px;width:7px;height:7px;border-radius:50%}
.si-dot.processing{background:var(--yellow);animation:p 1s infinite}.si-dot.success{background:var(--green)}.si-dot.error{background:var(--red)}.si-dot.intercepted{background:var(--pink)}
.r1{display:flex;align-items:center;justify-content:space-between;margin-bottom:3px}
.rid{font-family:var(--mono);font-size:10px;color:var(--cyan);font-weight:500;display:flex;align-items:center;gap:5px}
.rfmt{font-size:8px;font-weight:700;padding:1px 4px;border-radius:3px;text-transform:uppercase}
.rfmt.anthropic{background:rgba(139,92,246,.2);color:var(--purple)}.rfmt.openai{background:rgba(16,185,129,.2);color:var(--green)}.rfmt.responses{background:rgba(249,115,22,.2);color:var(--orange)}
.rtm{font-size:9px;color:var(--t3);font-family:var(--mono)}
.r2{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.rmod{font-size:10px;color:var(--t2);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rch{font-size:9px;color:var(--t3);font-family:var(--mono)}
.rbd{display:flex;gap:2px;flex-wrap:wrap}
.bg{font-size:8px;font-weight:500;padding:1px 4px;border-radius:8px}
.bg.str{background:rgba(6,182,212,.12);color:var(--cyan)}.bg.tls{background:rgba(139,92,246,.12);color:var(--purple)}.bg.rtr{background:rgba(245,158,11,.12);color:var(--yellow)}.bg.cnt{background:rgba(249,115,22,.12);color:var(--orange)}.bg.err{background:rgba(239,68,68,.12);color:var(--red)}.bg.icp{background:rgba(236,72,153,.12);color:var(--pink)}
.rdbar{height:2px;border-radius:1px;margin-top:4px;background:var(--bg0);overflow:hidden}
.rdfill{height:100%;border-radius:1px;transition:width .3s}
.rdfill.f{background:var(--green)}.rdfill.m{background:var(--yellow)}.rdfill.s{background:var(--orange)}.rdfill.vs{background:var(--red)}.rdfill.pr{background:var(--blue);animation:pp 1.5s infinite}
@keyframes pp{0%{opacity:1}50%{opacity:.4}100%{opacity:1}}

/* Detail Panel */
.dp{flex:1;display:flex;flex-direction:column;overflow:hidden}
.dh{padding:8px 14px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between;background:var(--bg1);flex-shrink:0}
.dh h2{font-size:12px;font-weight:600;display:flex;align-items:center;gap:5px}
.dh-acts{display:flex;gap:4px}

/* Tabs */
.tabs{display:flex;border-bottom:1px solid var(--bdr);background:var(--bg1);flex-shrink:0}
.tab{padding:7px 16px;font-size:11px;font-weight:500;color:var(--t2);cursor:pointer;border-bottom:2px solid transparent;transition:.2s;position:relative}
.tab:hover{color:var(--t1);background:rgba(255,255,255,.02)}
.tab.a{color:var(--cyan);border-bottom-color:var(--cyan)}
.tab .dot{position:absolute;top:4px;right:4px;width:5px;height:5px;border-radius:50%;background:var(--blue);display:none}

/* Tab Content */
.tab-content{flex:1;overflow-y:auto;padding:0;scrollbar-width:thin;scrollbar-color:var(--bdr) transparent}

/* Summary Card */
.scard{padding:10px 14px;background:var(--bg-card);border-bottom:1px solid var(--bdr);flex-shrink:0;display:none}
.sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.si2{display:flex;flex-direction:column;gap:1px}
.si2 .l{font-size:8px;text-transform:uppercase;color:var(--t3);letter-spacing:.3px}
.si2 .v{font-size:11px;font-weight:500;color:var(--t1);font-family:var(--mono)}

/* Phase Timeline */
.ptl{padding:8px 14px;border-bottom:1px solid var(--bdr);background:var(--bg-card);flex-shrink:0;display:none}
.ptl-lbl{font-size:9px;text-transform:uppercase;color:var(--t3);margin-bottom:4px;letter-spacing:.3px}
.ptl-bar{display:flex;height:20px;border-radius:4px;overflow:hidden;background:var(--bg0);gap:1px}
.pseg{display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:500;color:rgba(255,255,255,.85);min-width:2px;position:relative;cursor:default}
.pseg:hover{opacity:.8}
.pseg .tip{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--bdr);padding:3px 6px;border-radius:4px;font-size:9px;white-space:nowrap;pointer-events:none;opacity:0;transition:.1s;z-index:10}
.pseg:hover .tip{opacity:1}

/* Log entries */
.llist{padding:4px}
.le{display:grid;grid-template-columns:65px 48px 38px 60px 72px 1fr;gap:6px;padding:5px 8px;border-radius:4px;margin-bottom:1px;font-size:11px;position:relative;align-items:start}
.le:hover{background:var(--bg3)}
.le.ani{animation:fi .2s ease}
@keyframes fi{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}
.lt{font-family:var(--mono);font-size:9px;color:var(--t3);white-space:nowrap;padding-top:2px}
.ld{font-family:var(--mono);font-size:9px;color:var(--t3);text-align:right;padding-top:2px}
.ll{font-size:8px;font-weight:600;padding:2px 0;border-radius:2px;text-transform:uppercase;text-align:center}
.ll.debug{background:rgba(100,116,139,.12);color:var(--t3)}.ll.info{background:rgba(59,130,246,.1);color:var(--blue)}.ll.warn{background:rgba(245,158,11,.1);color:var(--yellow)}.ll.error{background:rgba(239,68,68,.1);color:var(--red)}
.ls{font-size:9px;font-weight:500;color:var(--purple);padding-top:2px}
.lp{font-size:8px;padding:2px 3px;border-radius:2px;background:rgba(6,182,212,.06);color:var(--cyan);text-align:center}
.lm{color:var(--t1);word-break:break-word;line-height:1.35}
.ldt{color:var(--blue);font-size:9px;cursor:pointer;margin-top:2px;display:inline-block;user-select:none}
.ldt:hover{text-decoration:underline}
.ldd{margin-top:3px;padding:6px 8px;background:var(--bg0);border-radius:4px;font-family:var(--mono);font-size:9px;color:var(--t2);white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto;border:1px solid var(--bdr);line-height:1.4}
.tli{position:absolute;left:0;top:0;bottom:0;width:2px;border-radius:0 2px 2px 0}

/* Content display (for request/response tabs) */
.content-section{padding:12px 16px;border-bottom:1px solid var(--bdr)}
.content-section:last-child{border-bottom:none}
.cs-title{font-size:11px;font-weight:600;color:var(--cyan);text-transform:uppercase;letter-spacing:.3px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.cs-title .cnt{font-size:9px;font-weight:400;color:var(--t3);font-family:var(--mono)}
.msg-item{margin-bottom:8px;border:1px solid var(--bdr);border-radius:6px;overflow:hidden}
.msg-header{padding:6px 10px;background:var(--bg2);display:flex;align-items:center;justify-content:space-between;cursor:pointer}
.msg-header:hover{background:var(--bg3)}
.msg-role{font-size:10px;font-weight:600;text-transform:uppercase;display:flex;align-items:center;gap:5px}
.msg-role.system{color:var(--pink)}.msg-role.user{color:var(--blue)}.msg-role.assistant{color:var(--green)}.msg-role.tool{color:var(--orange)}
.msg-meta{font-size:9px;color:var(--t3);font-family:var(--mono)}
.msg-body{padding:8px 10px;font-family:var(--mono);font-size:10px;color:var(--t2);white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:400px;overflow-y:auto;background:var(--bg0)}
.tool-item{padding:6px 10px;border:1px solid var(--bdr);border-radius:4px;margin-bottom:4px}
.tool-name{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--purple)}
.tool-desc{font-size:10px;color:var(--t3);margin-top:2px}
.resp-box{padding:10px 12px;background:var(--bg0);border:1px solid var(--bdr);border-radius:6px;font-family:var(--mono);font-size:10px;color:var(--t2);white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:600px;overflow-y:auto}
.resp-box.diff{border-color:var(--yellow)}
.retry-item{margin-bottom:8px;border:1px solid rgba(245,158,11,.2);border-radius:6px;overflow:hidden}
.retry-header{padding:5px 10px;background:rgba(245,158,11,.05);font-size:10px;font-weight:500;color:var(--yellow)}
.retry-body{padding:8px 10px;font-family:var(--mono);font-size:10px;color:var(--t2);white-space:pre-wrap;max-height:200px;overflow-y:auto;background:var(--bg0)}

/* JSON highlights */
.jk{color:var(--cyan)}.js{color:var(--green)}.jn{color:var(--yellow)}.jb{color:var(--purple)}.jnl{color:var(--t3)}

/* Empty */
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--t3);gap:8px}
.empty .ic{font-size:30px;opacity:.2}
.empty p{font-size:12px}.empty .sub{font-size:10px;opacity:.6}

/* Level filter pills */
.lvf{display:flex;gap:3px}
.lvb{padding:2px 8px;font-size:10px;border:1px solid var(--bdr);border-radius:5px;background:transparent;color:var(--t2);cursor:pointer;transition:.2s}
.lvb:hover{border-color:var(--blue);color:var(--blue)}.lvb.a{background:var(--blue);border-color:var(--blue);color:#fff}

/* Scrollbar */
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:2px}
</style>
</head>
<body>
<div class="app">
  <div class="hdr">
    <h1><span class="ic">⚡</span> Cursor2API 日志</h1>
    <div class="hdr-stats">
      <div class="sc"><b id="sT">0</b>请求</div>
      <div class="sc">✓<b id="sS">0</b></div>
      <div class="sc">✗<b id="sE">0</b></div>
      <div class="sc"><b id="sA">-</b>ms 均耗</div>
      <div class="sc">⚡<b id="sF">-</b>ms TTFT</div>
    </div>
    <div class="hdr-r">
      <div class="conn on" id="conn"><div class="d"></div><span>已连接</span></div>
    </div>
  </div>
  <div class="main">
    <div class="side">
      <div class="search"><div class="sw"><input class="si" id="searchIn" placeholder="搜索 requestId / model... (Ctrl+K)"/></div></div>
      <div class="fbar" id="fbar">
        <button class="fb a" data-f="all" onclick="fR('all',this)">全部<span class="fc" id="cA">0</span></button>
        <button class="fb" data-f="success" onclick="fR('success',this)">✓<span class="fc" id="cS">0</span></button>
        <button class="fb" data-f="error" onclick="fR('error',this)">✗<span class="fc" id="cE">0</span></button>
        <button class="fb" data-f="processing" onclick="fR('processing',this)">◌<span class="fc" id="cP">0</span></button>
        <button class="fb" data-f="intercepted" onclick="fR('intercepted',this)">⊘<span class="fc" id="cI">0</span></button>
      </div>
      <div class="rlist" id="rlist">
        <div class="empty"><div class="ic">📡</div><p>等待请求...</p></div>
      </div>
    </div>
    <div class="dp">
      <div class="dh">
        <h2>🔍 <span id="dTitle">实时日志流</span></h2>
        <div class="dh-acts">
          <div class="lvf" id="lvF">
            <button class="lvb a" onclick="sL('all',this)">全部</button>
            <button class="lvb" onclick="sL('info',this)">Info</button>
            <button class="lvb" onclick="sL('warn',this)">Warn</button>
            <button class="lvb" onclick="sL('error',this)">Error</button>
          </div>
        </div>
      </div>
      <div class="scard" id="scard"><div class="sgrid" id="sgrid"></div></div>
      <div class="ptl" id="ptl"><div class="ptl-lbl">阶段耗时</div><div class="ptl-bar" id="pbar"></div></div>
      <div class="tabs" id="tabs" style="display:none">
        <div class="tab a" onclick="setTab('logs',this)">📋 日志</div>
        <div class="tab" onclick="setTab('request',this)">📥 请求参数</div>
        <div class="tab" onclick="setTab('prompts',this)">💬 提示词</div>
        <div class="tab" onclick="setTab('response',this)">📤 响应内容</div>
      </div>
      <div class="tab-content" id="tabContent">
        <div class="llist" id="logList">
          <div class="empty"><div class="ic">📋</div><p>实时日志将在此显示</p><p class="sub">发起请求后即可看到全链路日志</p></div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let reqs=[],rmap={},logs=[],selId=null,cFil='all',cLv='all',sq='',curTab='logs',curPayload=null;
const PC={receive:'var(--blue)',convert:'var(--cyan)',send:'var(--purple)',response:'var(--purple)',thinking:'#a855f7',refusal:'var(--yellow)',retry:'var(--yellow)',truncation:'var(--yellow)',continuation:'var(--yellow)',toolparse:'var(--orange)',sanitize:'var(--orange)',stream:'var(--green)',complete:'var(--green)',error:'var(--red)',intercept:'var(--pink)',auth:'var(--t3)'};

// ★ Token 管理：从 URL 参数获取并存入 localStorage
const urlToken = new URLSearchParams(window.location.search).get('token');
if (urlToken) localStorage.setItem('cursor2api_token', urlToken);
const authToken = localStorage.getItem('cursor2api_token') || '';
function authQ(base) { return authToken ? (base.includes('?') ? base + '&token=' : base + '?token=') + encodeURIComponent(authToken) : base; }
function logoutBtn() {
  if (authToken) {
    const b = document.createElement('button');
    b.textContent = '退出';
    b.style.cssText = 'padding:2px 10px;font-size:10px;background:transparent;border:1px solid var(--bdr);border-radius:6px;color:var(--t2);cursor:pointer';
    b.onclick = () => { localStorage.removeItem('cursor2api_token'); window.location.href = '/logs'; };
    document.querySelector('.hdr-r').prepend(b);
  }
}

async function init(){
  try{
    const[a,b]=await Promise.all([fetch(authQ('/api/requests?limit=100')),fetch(authQ('/api/logs?limit=500'))]);
    if (a.status === 401) { localStorage.removeItem('cursor2api_token'); window.location.href = '/logs'; return; }
    reqs=await a.json();logs=await b.json();rmap={};reqs.forEach(r=>rmap[r.requestId]=r);
    renderRL();updCnt();updStats();
  }catch(e){console.error(e)}
  connectSSE();
  logoutBtn();
}

let es;
function connectSSE(){
  if(es)try{es.close()}catch{}
  es=new EventSource(authQ('/api/logs/stream'));
  es.addEventListener('log',e=>{const en=JSON.parse(e.data);logs.push(en);if(logs.length>5000)logs=logs.slice(-3000);if(!selId||selId===en.requestId){if(curTab==='logs')appendLog(en)}});
  es.addEventListener('summary',e=>{const s=JSON.parse(e.data);const isNew=!rmap[s.requestId];rmap[s.requestId]=s;const i=reqs.findIndex(r=>r.requestId===s.requestId);if(i>=0)reqs[i]=s;else reqs.unshift(s);renderRL();updCnt();if(selId===s.requestId)renderSCard(s)});
  es.addEventListener('stats',e=>{applyStats(JSON.parse(e.data))});
  es.onopen=()=>{const c=document.getElementById('conn');c.className='conn on';c.querySelector('span').textContent='已连接'};
  es.onerror=()=>{const c=document.getElementById('conn');c.className='conn off';c.querySelector('span').textContent='重连中...';setTimeout(connectSSE,3000)};
}

function updStats(){fetch(authQ('/api/stats')).then(r=>r.json()).then(applyStats).catch(()=>{})}
function applyStats(s){document.getElementById('sT').textContent=s.totalRequests;document.getElementById('sS').textContent=s.successCount;document.getElementById('sE').textContent=s.errorCount;document.getElementById('sA').textContent=s.avgResponseTime||'-';document.getElementById('sF').textContent=s.avgTTFT||'-'}

function updCnt(){
  const q=sq.toLowerCase();let a=0,s=0,e=0,p=0,i=0;
  reqs.forEach(r=>{if(q&&!mS(r,q))return;a++;if(r.status==='success')s++;else if(r.status==='error')e++;else if(r.status==='processing')p++;else if(r.status==='intercepted')i++});
  document.getElementById('cA').textContent=a;document.getElementById('cS').textContent=s;document.getElementById('cE').textContent=e;document.getElementById('cP').textContent=p;document.getElementById('cI').textContent=i;
}
function mS(r,q){return r.requestId.includes(q)||r.model.toLowerCase().includes(q)||r.path.toLowerCase().includes(q)}

function renderRL(){
  const el=document.getElementById('rlist');const q=sq.toLowerCase();
  let f=reqs;if(q)f=f.filter(r=>mS(r,q));if(cFil!=='all')f=f.filter(r=>r.status===cFil);
  if(!f.length){el.innerHTML='<div class="empty"><div class="ic">📡</div><p>'+(q?'无匹配':'暂无请求')+'</p></div>';return}
  el.innerHTML=f.map(r=>{
    const ac=r.requestId===selId,ago=timeAgo(r.startTime),dur=r.endTime?((r.endTime-r.startTime)/1000).toFixed(1)+'s':'...',durMs=r.endTime?r.endTime-r.startTime:Date.now()-r.startTime;
    const pct=Math.min(100,durMs/30000*100),dc=!r.endTime?'pr':durMs<3000?'f':durMs<10000?'m':durMs<20000?'s':'vs';
    const ch=r.responseChars>0?fmtN(r.responseChars)+' chars':'',tt=r.ttft?r.ttft+'ms':'';
    let bd='';if(r.stream)bd+='<span class="bg str">Stream</span>';if(r.hasTools)bd+='<span class="bg tls">T:'+r.toolCount+'</span>';
    if(r.retryCount>0)bd+='<span class="bg rtr">R:'+r.retryCount+'</span>';if(r.continuationCount>0)bd+='<span class="bg cnt">C:'+r.continuationCount+'</span>';
    if(r.status==='error')bd+='<span class="bg err">ERR</span>';if(r.status==='intercepted')bd+='<span class="bg icp">INTERCEPT</span>';
    const fm=r.apiFormat||'anthropic';
    return '<div class="ri'+(ac?' a':'')+'" data-r="'+r.requestId+'">'+'<div class="si-dot '+r.status+'"></div>'+'<div class="r1"><span class="rid">'+r.requestId+' <span class="rfmt '+fm+'">'+fm+'</span></span><span class="rtm">'+(tt?'⚡'+tt+' · ':'')+dur+' · '+ago+'</span></div>'+'<div class="r2"><span class="rmod">'+escH(r.model)+'</span>'+(ch?'<span class="rch">→ '+ch+'</span>':'')+'</div>'+'<div class="rbd">'+bd+'</div>'+'<div class="rdbar"><div class="rdfill '+dc+'" style="width:'+pct+'%"></div></div></div>';
  }).join('');
}

// ===== Select Request =====
async function selReq(id){
  if(selId===id){desel();return}
  selId=id;renderRL();
  const s=rmap[id];
  if(s){document.getElementById('dTitle').textContent='请求 '+id;renderSCard(s)}
  document.getElementById('tabs').style.display='flex';
  curTab='logs';setTab('logs',document.querySelector('.tab'));
  // Load payload data
  try{const r=await fetch(authQ('/api/payload/'+id));if(r.ok)curPayload=await r.json();else curPayload=null}catch{curPayload=null}
  // Render log tab
  const ll=logs.filter(l=>l.requestId===id);renderLogs(ll);
}

function desel(){
  selId=null;curPayload=null;renderRL();
  document.getElementById('dTitle').textContent='实时日志流';
  document.getElementById('scard').style.display='none';
  document.getElementById('ptl').style.display='none';
  document.getElementById('tabs').style.display='none';
  curTab='logs';
  renderLogs(logs.slice(-200));
}

function renderSCard(s){
  const c=document.getElementById('scard');c.style.display='block';
  const dur=s.endTime?((s.endTime-s.startTime)/1000).toFixed(2)+'s':'进行中...';
  const sc={processing:'var(--yellow)',success:'var(--green)',error:'var(--red)',intercepted:'var(--pink)'}[s.status]||'var(--t3)';
  const items=[['状态','<span style="color:'+sc+'">'+s.status.toUpperCase()+'</span>'],['耗时',dur],['模型',escH(s.model)],['格式',(s.apiFormat||'anthropic').toUpperCase()],['消息数',s.messageCount],['响应字数',fmtN(s.responseChars)],['TTFT',s.ttft?s.ttft+'ms':'-'],['API耗时',s.cursorApiTime?s.cursorApiTime+'ms':'-'],['停止原因',s.stopReason||'-'],['重试',s.retryCount],['续写',s.continuationCount],['工具调用',s.toolCallsDetected]];
  if(s.thinkingChars>0)items.push(['Thinking',fmtN(s.thinkingChars)+' chars']);
  if(s.error)items.push(['错误','<span style="color:var(--red)">'+escH(s.error)+'</span>']);
  document.getElementById('sgrid').innerHTML=items.map(([l,v])=>'<div class="si2"><span class="l">'+l+'</span><span class="v">'+v+'</span></div>').join('');
  renderPTL(s);
}

function renderPTL(s){
  const el=document.getElementById('ptl'),bar=document.getElementById('pbar');
  if(!s.phaseTimings||!s.phaseTimings.length){el.style.display='none';return}
  el.style.display='block';const tot=(s.endTime||Date.now())-s.startTime;if(tot<=0){el.style.display='none';return}
  bar.innerHTML=s.phaseTimings.map(pt=>{const d=pt.duration||((pt.endTime||Date.now())-pt.startTime);const pct=Math.max(1,d/tot*100);const bg=PC[pt.phase]||'var(--t3)';return '<div class="pseg" style="width:'+pct+'%;background:'+bg+'" title="'+pt.label+': '+d+'ms"><span class="tip">'+escH(pt.label)+' '+d+'ms</span>'+(pct>10?'<span style="font-size:7px">'+pt.phase+'</span>':'')+'</div>'}).join('');
}

// ===== Tabs =====
function setTab(tab,el){
  curTab=tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('a'));
  el.classList.add('a');
  const tc=document.getElementById('tabContent');
  if(tab==='logs'){
    tc.innerHTML='<div class="llist" id="logList"></div>';
    if(selId){renderLogs(logs.filter(l=>l.requestId===selId))}else{renderLogs(logs.slice(-200))}
  } else if(tab==='request'){
    renderRequestTab(tc);
  } else if(tab==='prompts'){
    renderPromptsTab(tc);
  } else if(tab==='response'){
    renderResponseTab(tc);
  }
}

function renderRequestTab(tc){
  if(!curPayload){tc.innerHTML='<div class="empty"><div class="ic">📥</div><p>暂无请求数据</p></div>';return}
  let h='';
  // Original request summary
  const s=selId?rmap[selId]:null;
  if(s){
    h+='<div class="content-section"><div class="cs-title">📋 请求概要</div>';
    h+='<div class="resp-box">'+syntaxHL({method:s.method,path:s.path,model:s.model,stream:s.stream,apiFormat:s.apiFormat,messageCount:s.messageCount,toolCount:s.toolCount,hasTools:s.hasTools})+'</div></div>';
  }
  // Tools
  if(curPayload.tools&&curPayload.tools.length){
    h+='<div class="content-section"><div class="cs-title">🔧 工具定义 <span class="cnt">'+curPayload.tools.length+' 个</span></div>';
    curPayload.tools.forEach(t=>{h+='<div class="tool-item"><div class="tool-name">'+escH(t.name)+'</div>'+(t.description?'<div class="tool-desc">'+escH(t.description)+'</div>':'')+'</div>'});
    h+='</div>';
  }
  // Cursor request
  if(curPayload.cursorRequest){
    h+='<div class="content-section"><div class="cs-title">🔄 Cursor 请求（转换后）</div>';
    h+='<div class="resp-box">'+syntaxHL(curPayload.cursorRequest)+'</div></div>';
  }
  if(curPayload.cursorMessages&&curPayload.cursorMessages.length){
    h+='<div class="content-section"><div class="cs-title">📨 Cursor 消息列表 <span class="cnt">'+curPayload.cursorMessages.length+' 条</span></div>';
    curPayload.cursorMessages.forEach((m,i)=>{
      const collapsed=m.contentPreview.length>500;
      h+='<div class="msg-item"><div class="msg-header" onclick="togMsg(this)"><span class="msg-role '+m.role+'">'+m.role+' #'+(i+1)+'</span><span class="msg-meta">'+fmtN(m.contentLength)+' chars '+(collapsed?'▶ 展开':'▼ 收起')+'</span></div><div class="msg-body" style="display:'+(collapsed?'none':'block')+';max-height:800px;overflow-y:auto">'+escH(m.contentPreview)+'</div></div>';
    });
    h+='</div>';
  }
  tc.innerHTML=h||'<div class="empty"><div class="ic">📥</div><p>暂无请求数据</p></div>';
}

function renderPromptsTab(tc){
  if(!curPayload){tc.innerHTML='<div class="empty"><div class="ic">💬</div><p>暂无提示词数据</p></div>';return}
  let h='';
  // System prompt
  if(curPayload.systemPrompt){
    h+='<div class="content-section"><div class="cs-title">🔒 System Prompt <span class="cnt">'+fmtN(curPayload.systemPrompt.length)+' chars</span></div>';
    h+='<div class="resp-box" style="max-height:600px;overflow-y:auto">'+escH(curPayload.systemPrompt)+'</div></div>';
  }
  // Messages
  if(curPayload.messages&&curPayload.messages.length){
    h+='<div class="content-section"><div class="cs-title">💬 消息列表 <span class="cnt">'+curPayload.messages.length+' 条</span></div>';
    curPayload.messages.forEach((m,i)=>{
      const imgs=m.hasImages?' 🖼️':'';
      const collapsed=m.contentPreview.length>500;
      h+='<div class="msg-item"><div class="msg-header" onclick="togMsg(this)"><span class="msg-role '+m.role+'">'+m.role+imgs+' #'+(i+1)+'</span><span class="msg-meta">'+fmtN(m.contentLength)+' chars '+(collapsed?'▶ 展开':'▼ 收起')+'</span></div><div class="msg-body" style="display:'+(collapsed?'none':'block')+';max-height:800px;overflow-y:auto">'+escH(m.contentPreview)+'</div></div>';
    });
    h+='</div>';
  }
  tc.innerHTML=h||'<div class="empty"><div class="ic">💬</div><p>暂无提示词数据</p></div>';
}

function renderResponseTab(tc){
  if(!curPayload){tc.innerHTML='<div class="empty"><div class="ic">📤</div><p>暂无响应数据</p></div>';return}
  let h='';
  // Thinking
  if(curPayload.thinkingContent){
    h+='<div class="content-section"><div class="cs-title">🧠 Thinking 内容 <span class="cnt">'+fmtN(curPayload.thinkingContent.length)+' chars</span></div>';
    h+='<div class="resp-box" style="border-color:var(--purple);max-height:300px">'+escH(curPayload.thinkingContent)+'</div></div>';
  }
  // Raw response
  if(curPayload.rawResponse){
    h+='<div class="content-section"><div class="cs-title">📝 模型原始返回 <span class="cnt">'+fmtN(curPayload.rawResponse.length)+' chars</span></div>';
    h+='<div class="resp-box" style="max-height:400px">'+escH(curPayload.rawResponse)+'</div></div>';
  }
  // Final response
  if(curPayload.finalResponse&&curPayload.finalResponse!==curPayload.rawResponse){
    h+='<div class="content-section"><div class="cs-title">✅ 最终响应（处理后）<span class="cnt">'+fmtN(curPayload.finalResponse.length)+' chars</span></div>';
    h+='<div class="resp-box diff" style="max-height:400px">'+escH(curPayload.finalResponse)+'</div></div>';
  }
  // Tool calls
  if(curPayload.toolCalls&&curPayload.toolCalls.length){
    h+='<div class="content-section"><div class="cs-title">🔧 工具调用结果 <span class="cnt">'+curPayload.toolCalls.length+' 个</span></div>';
    h+='<div class="resp-box">'+syntaxHL(curPayload.toolCalls)+'</div></div>';
  }
  // Retry history
  if(curPayload.retryResponses&&curPayload.retryResponses.length){
    h+='<div class="content-section"><div class="cs-title">🔄 重试历史 <span class="cnt">'+curPayload.retryResponses.length+' 次</span></div>';
    curPayload.retryResponses.forEach(r=>{h+='<div class="retry-item"><div class="retry-header">第 '+r.attempt+' 次重试 — '+escH(r.reason)+'</div><div class="retry-body">'+escH(r.response.substring(0,1000))+(r.response.length>1000?'\\n... ('+fmtN(r.response.length)+' chars)':'')+'</div></div>'});
    h+='</div>';
  }
  // Continuation history
  if(curPayload.continuationResponses&&curPayload.continuationResponses.length){
    h+='<div class="content-section"><div class="cs-title">📎 续写历史 <span class="cnt">'+curPayload.continuationResponses.length+' 次</span></div>';
    curPayload.continuationResponses.forEach(r=>{h+='<div class="retry-item"><div class="retry-header" style="color:var(--orange)">续写 #'+r.index+' (去重后 '+fmtN(r.dedupedLength)+' chars)</div><div class="retry-body">'+escH(r.response.substring(0,1000))+(r.response.length>1000?'\\n...':'')+'</div></div>'});
    h+='</div>';
  }
  tc.innerHTML=h||'<div class="empty"><div class="ic">📤</div><p>暂无响应数据</p></div>';
}

// ===== Log rendering =====
function renderLogs(ll){
  const el=document.getElementById('logList');if(!el)return;
  const fil=cLv==='all'?ll:ll.filter(l=>l.level===cLv);
  if(!fil.length){el.innerHTML='<div class="empty"><div class="ic">📋</div><p>暂无日志</p></div>';return}
  el.innerHTML=fil.map(l=>logH(l)).join('');el.scrollTop=el.scrollHeight;
}
function logH(l){
  const t=new Date(l.timestamp).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const d=l.duration!=null?'+'+l.duration+'ms':'';
  const det=l.details?'<div class="ldt" onclick="togDet(this)">▶ 详情</div><div class="ldd" style="display:none">'+syntaxHL(l.details)+'</div>':'';
  return '<div class="le"><div class="tli" style="background:'+(PC[l.phase]||'var(--t3)')+'"></div><span class="lt">'+t+'</span><span class="ld">'+d+'</span><span class="ll '+l.level+'">'+l.level+'</span><span class="ls">'+l.source+'</span><span class="lp">'+l.phase+'</span><div class="lm">'+escH(l.message)+det+'</div></div>';
}
function appendLog(en){
  const el=document.getElementById('logList');if(!el)return;
  if(el.querySelector('.empty'))el.innerHTML='';
  if(cLv!=='all'&&en.level!==cLv)return;
  const d=document.createElement('div');d.innerHTML=logH(en);const n=d.firstElementChild;n.classList.add('ani');el.appendChild(n);
  while(el.children.length>500)el.removeChild(el.firstChild);
  el.scrollTop=el.scrollHeight;
}

// ===== Utils =====
function escH(s){if(!s)return'';const d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function timeAgo(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<5)return'刚刚';if(s<60)return s+'s前';if(s<3600)return Math.floor(s/60)+'m前';return Math.floor(s/3600)+'h前'}
function fmtN(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n)}
function syntaxHL(data){
  try{const s=typeof data==='string'?data:JSON.stringify(data,null,2);
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"([^"]+)"\\s*:/g,'<span class="jk">"$1"</span>:')
    .replace(/:\\s*"([^"]*?)"/g,': <span class="js">"$1"</span>')
    .replace(/:\\s*(\\d+\\.?\\d*)/g,': <span class="jn">$1</span>')
    .replace(/:\\s*(true|false)/g,': <span class="jb">$1</span>')
    .replace(/:\\s*(null)/g,': <span class="jnl">null</span>')
  }catch{return escH(String(data))}
}
function togDet(el){const d=el.nextElementSibling;if(d.style.display==='none'){d.style.display='block';el.textContent='▼ 收起'}else{d.style.display='none';el.textContent='▶ 详情'}}
function togMsg(el){const b=el.nextElementSibling;const isHidden=b.style.display==='none';b.style.display=isHidden?'block':'none';const m=el.querySelector('.msg-meta');if(m){const t=m.textContent;m.textContent=isHidden?t.replace('▶ 展开','▼ 收起'):t.replace('▼ 收起','▶ 展开')}}
function fR(f,btn){cFil=f;document.querySelectorAll('#fbar .fb').forEach(b=>b.classList.remove('a'));btn.classList.add('a');renderRL()}
function sL(lv,btn){cLv=lv;document.querySelectorAll('#lvF .lvb').forEach(b=>b.classList.remove('a'));btn.classList.add('a');if(curTab==='logs'){if(selId)renderLogs(logs.filter(l=>l.requestId===selId));else renderLogs(logs.slice(-200))}}

// Keyboard
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();document.getElementById('searchIn').focus();return}
  if(e.key==='Escape'){if(document.activeElement===document.getElementById('searchIn')){document.getElementById('searchIn').blur();document.getElementById('searchIn').value='';sq='';renderRL();updCnt()}else{desel()}return}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const q=sq.toLowerCase();let f=reqs;if(q)f=f.filter(r=>mS(r,q));if(cFil!=='all')f=f.filter(r=>r.status===cFil);if(!f.length)return;const ci=selId?f.findIndex(r=>r.requestId===selId):-1;let ni;if(e.key==='ArrowDown')ni=ci<f.length-1?ci+1:0;else ni=ci>0?ci-1:f.length-1;selReq(f[ni].requestId);const it=document.querySelector('[data-r="'+f[ni].requestId+'"]');if(it)it.scrollIntoView({block:'nearest'})}
});

document.getElementById('searchIn').addEventListener('input',e=>{sq=e.target.value;renderRL();updCnt()});
document.getElementById('rlist').addEventListener('click',e=>{const el=e.target.closest('[data-r]');if(el)selReq(el.getAttribute('data-r'))});
setInterval(renderRL,30000);
init();
</script>
</body>
</html>`;
