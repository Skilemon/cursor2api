# jscode 目录

此目录存放 x-is-human token 生成所需的 JS 文件。

## 文件说明

- **env.js** - 浏览器环境模拟脚本（模拟 navigator, window, document 等 DOM API）
- **main.js** - Token 生成入口脚本（模板文件，包含占位符）

## 获取方式

### env.js
```bash
curl -o jscode/env.js https://raw.githubusercontent.com/jhhgiyv/cursorweb2api/master/jscode/env.js
```

### main.js
```bash
curl -o jscode/main.js https://raw.githubusercontent.com/jhhgiyv/cursorweb2api/master/jscode/main.js
```

## 占位符说明 (main.js)

main.js 中包含以下占位符，运行时会被实际值替换：
- `$$currentScriptSrc$$` → script_url
- `$$UNMASKED_VENDOR_WEBGL$$` → 显卡厂商信息
- `$$UNMASKED_RENDERER_WEBGL$$` → 显卡渲染器信息
- `$$userAgent$$` → 浏览器 UA
- `$$env_jscode$$` → env.js 内容
- `$$cursor_jscode$$` → Cursor 验证脚本内容
