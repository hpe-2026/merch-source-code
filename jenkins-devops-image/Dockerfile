FROM node:20-alpine

RUN apk add --no-cache git python3 py3-pip curl bash openssl jq

RUN YQ_VERSION="v4.40.5" && \
    curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" -o /usr/local/bin/yq && \
    chmod +x /usr/local/bin/yq

WORKDIR /home/jenkins/agent