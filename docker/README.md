# 在容器里测这个插件

两条路。都不需要 Windows —— 也正因为如此，它们顺便回答了「这东西在 Linux 上到底是什么状态」。

## 一、纯测试容器（`Dockerfile.test`）

```bash
docker build -f docker/Dockerfile.test -t dsh-world-test .
docker run --rm dsh-world-test sh -lc 'cd /app && npm test -- $(ls tests/*.test.ts | grep -vE "qqNative\.test\.ts|qqSnowluma\.test\.ts|plugin\.test\.ts")'
```

拉不动 docker hub 的地方，换基础镜像源就行，不用改文件：

```bash
docker build -f docker/Dockerfile.test \
  --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22-slim \
  -t dsh-world-test .
```

里面跑的是 `npm run typecheck && npm run build`，然后**可移植的那部分测试**。宿主与会话都是假的，不需要 DSH，也不需要模型。

### 在 Linux 上跑什么、不跑什么

**整份不跑的**（构建时按文件名排除）：

| 文件 | 为什么 |
| --- | --- |
| `tests/plugin.test.ts`、`tests/qqNative.test.ts`、`tests/qqSnowluma.test.ts` | 它们 import 到 `src/...`，而那条链上有 `@snowluma/sdk`；那个包的 `dist/index.js` 里 `import './client/api-client'` 在大小写敏感的文件系统上 `ERR_MODULE_NOT_FOUND`。**上游包的问题，但它意味着 QQ 通道在 Linux 上载入不了** |

**跑、但里面有几条标了 `process.platform !== 'win32'` 跳过**：

| 断言 | 为什么只对 Windows 成立 |
| --- | --- |
| `enable script changes only the compaction plugin…` | 跑的是 `scripts/enable-tool-free-compaction.ps1`，要 PowerShell |
| `file tools are outside only when a path leaves the room`、`path boundaries: the room itself, case, dot-dot names, UNC`、`nested and extra path keys are inspected` | 断言的是 Windows 路径语义：盘符、UNC、反斜杠分段、大小写不敏感 |
| `面板密码记在她世界目录旁边，只有本机用户能读…` | 「只有本机用户能读」在 Windows 上是 ACL，在 Linux 上是 mode 位 |

**结论：这一版是 Windows 插件。** 上面这些要么命里注定（PowerShell、ACL），要么依赖一个只在 Windows 上装得好的上游包；标出来是为了让容器里的红色只代表真回归。

## 二、带宿主的一体化冒烟（`Dockerfile.smoke`）

真要回答「陌生人照着 INSTALL 装得上吗」，得把 DSH 宿主也装进去：

```bash
docker build -f docker/Dockerfile.smoke --build-arg BASE_IMAGE=node:22-slim -t dsh-world-smoke .
docker run --rm dsh-world-smoke
```

它做的是：`npm pack` 出 `dsh-world-0.6.0.tgz` → `dsh plugin --profile qa add <tgz>` → 用 `docker/container.yml` 那一层覆盖把 `qqNative` 打开并指向容器里的假 OneBot → `dsh web --profile qa` 起一个**没有界面**的宿主 → `docker/smoke.mjs` 等端口、喂一条假群消息、断言 `/dsh-world/qq/native` 收到、`/dsh-world/console/snapshot` 里有 `native`、阳台能连上。

能证明的是「装上、起得来、收得到、开得出会话」；**证明不了「她回一句话」** —— 那要模型凭据。

## 三、这台机器的两个坑（记下来省得再踩）

1. `-v` 挂载路径要给 Windows 形式，且 bash 里要 `MSYS_NO_PATHCONV=1`，否则 `/c/Users/...` 会被改成 `W:/` 这样的东西，Docker 报 `working directory 'W:/' is invalid`。
2. `docker build` 报 `failed to fetch anonymous token` 就是 docker hub 连不上，用上面那个 `--build-arg BASE_IMAGE=` 换源。