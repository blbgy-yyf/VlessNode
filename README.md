# Cloudflare Workers

## 部署到 codesandbox

- 进入 codesandbox 后关联该项目，则可完成自动部署，会部署到 codesandbox 提供的 cloudflare 账号的 workers 服务
 - 此种方式无法匿名 UUID ，为 wrangler.toml 中定义的 UUID 值

## 部署到私人 cloudflare workers

- 借助 github actions ，在 github 项目中设置好 actions secrets 变量
  - ${{ secrets.CF_API_TOKEN }} 私人 cloudflare API_TOKEN
  - ${{ secrets.CF_ACCOUNT_ID }} 私人 cloudflare ACCOUNT_ID
  - ${{ secrets.UUID }} 服务链接时的 UUID
