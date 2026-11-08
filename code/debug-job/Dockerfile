# Debug Job image: one image for the receiver init container, the key helper
# sidecar and the Claude container. The Job template sets each container's
# command (node /app/src/receiver.ts, node /app/src/keyHelper.ts,
# node /app/src/wrapper.ts); the startup isolation check Job runs
# node /app/src/isolationCheck.ts.
# Node 24 runs the .ts files directly by stripping types, so there is no build step.
FROM node:24-alpine

RUN npm install -g @anthropic-ai/claude-code@2.1.316 \
    && npm cache clean --force

# No self-update and no telemetry or other non-essential calls from the Job.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

WORKDIR /app
COPY schema/ /app/schema/
COPY src/ /app/src/

# The node user of the base image; never root.
USER 1000:1000
