#!/usr/bin/env bash
# 服务器基础环境：Node 24 + dsh 运行时 + Docker + Pillow。幂等，可重复跑。
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }

NODE_VER="${NODE_VER:-v24.18.0}"
DSH_VER="${DSH_VER:-0.2.1-rc.2}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

echo "== 1/5 系统依赖 =="
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates git xz-utils tar python3 python3-pil
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y curl ca-certificates git xz tar python3
  dnf install -y python3-pillow || pip3 install -i https://mirrors.aliyun.com/pypi/simple/ pillow
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ca-certificates git xz tar python3
  yum install -y python3-pillow || pip3 install -i https://mirrors.aliyun.com/pypi/simple/ pillow
else
  echo "未识别的包管理器"; exit 1
fi

echo "== 2/5 Node $NODE_VER =="
if ! /opt/node/bin/node -v 2>/dev/null | grep -q "^${NODE_VER}$"; then
  curl -fL --retry 3 -o /tmp/node.tar.xz \
    "https://npmmirror.com/mirrors/node/${NODE_VER}/node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz" \
    || curl -fL --retry 3 -o /tmp/node.tar.xz \
    "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-${NODE_ARCH}.tar.xz"
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
fi
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx
/opt/node/bin/node -v

echo "== 3/5 dsh $DSH_VER =="
export PATH=/opt/node/bin:$PATH
npm config set registry https://registry.npmmirror.com
if [ ! -f /root/.dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js ]; then
  npm install --prefix /root/.dsh-runtime --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VER}"
fi
cat >/usr/local/bin/dsh <<'EOF'
#!/bin/sh
export DSH_HOME="${DSH_HOME:-/root/.dsh}"
exec /opt/node/bin/node /root/.dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
chmod +x /usr/local/bin/dsh
dsh --version

echo "== 4/5 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  if curl -fsSL --retry 3 https://get.docker.com -o /tmp/get-docker.sh; then
    sh /tmp/get-docker.sh --mirror Aliyun
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get install -y docker.io
  else
    dnf install -y docker || yum install -y docker
  fi
fi
systemctl enable --now docker
docker --version

echo "== 5/5 swap（内存 < 3G 且无 swap 时加 2G） =="
MEM_MB=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
if [ "$MEM_MB" -lt 3000 ] && [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "内存 ${MEM_MB}MB，swap: $(swapon --show --noheadings | wc -l) 个"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || true
echo "== bootstrap 完成 =="
