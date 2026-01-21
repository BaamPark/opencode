## New Feature: `/simulate` (LLM-as-a-user)
[README_original.md](README_original.md)
- Use `/simulate` to have an LLM act as the user and propose the next task based on the current session.
- Configure simulator model, max turns, and an optional external context path (file or directory).
- The prompt footer shows the simulation turn/status and, when set, the external context path for clarity.
- Added or modified Files
  - `packages/opencode/src/cli/cmd/tui/app.tsx`
  - `packages/opencode/src/cli/cmd/tui/context/simulate.tsx`
  - `packages/opencode/src/cli/cmd/tui/util/simulate.ts`
  - `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/tui/component/dialog-simulate.tsx`

## Running OpenCode in a Docker Sandbox

### 1. Build the image
```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.5"
bun install
cd packages/opencode
bun run build
docker build -t opencode .
```

### 2. Quick start (no providers mounted)
```bash
docker run -it --rm \
  -v /home/beomseok/sandbox:/workspace \
  -w /workspace \
  opencode
```

### 3. Use Ollama inside the sandbox
1. Start Ollama on the host (all interfaces):
   ```bash
   OLLAMA_CONTEXT_LENGTH=120000 OLLAMA_HOST=0.0.0.0 ollama serve
   ```
2. Create `/home/beomseok/sandbox/.opencode/opencode.json` with your models:
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ollama": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Ollama (local)",
         "options": {
           "baseURL": "http://host.docker.internal:11434/v1"
         },
         "models": {
           "qwen3-coder:30b": { "name": "qwen3-coder:30b" },
           "gpt-oss:20b":     { "name": "gpt-oss:20b" }
         }
       }
     }
   }
   ```
3. Run OpenCode with host access to Ollama:
   ```bash
   docker run -it --rm \
     -v /home/beomseok/sandbox:/workspace \
     -w /workspace \
     --add-host=host.docker.internal:host-gateway \
     -e OLLAMA_HOST="http://host.docker.internal:11434/v1" \
     opencode
   ```

### 4. Troubleshoot connectivity
- Verify the sandbox can reach Ollama:
  ```bash
  docker run -it --rm \
    -v /home/beomseok/sandbox:/workspace \
    -w /workspace \
    --add-host=host.docker.internal:host-gateway \
    --entrypoint /bin/sh \
    opencode -lc 'apk add --no-cache curl >/dev/null && curl -v http://host.docker.internal:11434/'
  ```
- If it times out, adjust firewall rules (example):
  ```bash
  sudo ufw allow from 172.17.0.0/16 to any port 11434
  ```