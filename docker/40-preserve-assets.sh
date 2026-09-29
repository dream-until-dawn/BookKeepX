#!/bin/sh
# 保留旧版哈希资源，推迟刷新的标签页仍能加载旧页面分包。
set -eu
cp -a /opt/bookkeepx-assets/. /usr/share/nginx/html/assets/
