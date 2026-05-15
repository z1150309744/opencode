~/.local/share/opencode/opencode-local.db
bun run --cwd packages/app dev


- ~/.local/share/opencode/ — 数据库、认证信息、快照、日志
- ~/.cache/opencode/ — 模型缓存、二进制工具
- ~/.config/opencode/ — 全局配置、TUI配置、主题
- ~/.local/state/opencode/ — 锁文件、插件元数据
- ~/.opencode/ — CLI 安装（二进制+依赖）
- .opencode/（项目内） — 项目级配置、代理、命令
- ./logs/dev.log — 开发日志
