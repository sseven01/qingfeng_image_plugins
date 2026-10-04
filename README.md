# qingfeng_image_plugins

青枫生态 WordPress 插件合集。每个插件一个独立子目录，可单独复制分发。

## 插件列表

### image-host-picker（图床选图器）

在 WordPress 经典编辑器工具栏添加「图床」按钮，弹出面板浏览青枫图床的目录、搜索图片，点选后将图片直链插入文章。适用于任何主题，也可与青枫主题自带的图床选图功能并存。

#### 环境要求

- WordPress 5.0+，PHP 7.2+
- 经典编辑器（TinyMCE）：Gutenberg 主题需安装 [Classic Editor](https://wordpress.org/plugins/classic-editor/) 插件
- 一台青枫图床服务（[qingfeng-image-host](https://github.com/sseven01/qingfeng-image-host)）及其中只读 API Token

#### 安装

1. 将 `image-host-picker/` 目录复制到站点 `wp-content/plugins/`（或克隆本仓库后整目录放入）
2. 后台「插件」页激活「图床选图器」

#### 配置

后台 **设置 → 图床选图器**：

| 配置项 | 填写内容 |
|---|---|
| 图床地址 | 图床根地址，不带末尾斜杠，如 `https://img.example.com` |
| 只读 Token | 图床 `.env` 中 `API_TOKEN` 的值 |

Token 只存在服务端 option，不下发浏览器，图床无需开放 CORS。

#### 使用

1. 新建/编辑文章，点工具栏**第二行**的「图床」按钮
2. 面板内：左侧目录树切换目录，右侧图片网格单击选中、双击直接插入
3. 搜索框输入关键词回车可搜图；「复制 Markdown」生成 `![文件名](直链)` 格式

#### 与青枫主题并存

青枫主题自带图床选图模块。插件激活时检测到主题模块（`zhuige_image_host_proxy` 等函数存在）会自动让位：不注册按钮、不加载脚本，设置页显示提示，避免出现两个「图床」按钮。如需强制启停，可用过滤器 `image_host_picker_suppress`（返回 true 强制禁用 / false 强制启用）。

#### 依赖的图床 API

插件通过服务端代理请求以下只读接口（鉴权：`Authorization: Bearer <只读Token>`）：

| 接口 | 用途 |
|---|---|
| `GET /api/tree` | 目录树 |
| `GET /api/items?path=` | 目录内容 |
| `GET /api/images/search?q=` | 图片搜索 |

图片插入用的是图床直链 `https://图床域名/i/路径`，公开访问、永久不变。接口详细说明见图床仓库的 README「API 调用」章节。

## 许可

GPL v2 or later（与 WordPress 一致）。
