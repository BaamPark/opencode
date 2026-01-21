# Running OpenCode in a Docker Sandbox

## 1. Prerequisite
```bash
cd packages/opencode
run bun build
docker build -t opencode .
```

## 2. Quick Start
```bash
docker run -it --rm \
  -v /home/beomseok/sandbox:/workspace \
  -w /workspace \
  opencode
```

## 3. OpenCode with Ollama on Docker sandbox
### 3.1 Run Ollama on with all interfaces
```bash
OLLAMA_CONTEXT_LENGTH=120000 OLLAMA_HOST=0.0.0.0 ollama serve
```

### 3.2 Set volume mount and configuration json
You should first set up a volume mount by mapping a directory on the host machine to the Docker sandbox directory. Make an empty folder (e.g., /home/beomseok/sandbox), and then add `/home/beomseok/sandbox/.opencode/opencode.json` from a host machine:

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
        "qwen3-coder:30b": {
          "name": "qwen3-coder:30b"
        },
        "gpt-oss:20b": {
          "name": "gpt-oss:20b"
        }
      }
    }
  }
}
```
### 3.3 Run Opencode on Docker Sandbox
Once the json file is ready, you can run the following command to run opencode.

```bash
docker run -it --rm \
  -v /home/beomseok/sandbox:/workspace \
  -w /workspace \
  --add-host=host.docker.internal:host-gateway \
  -e OLLAMA_HOST="http://host.docker.internal:11434/v1" \
  opencode
```

### Didn't work?
Check whether docker sandbox can reach the ollama service.
```bash
docker run -it --rm \
  -v /home/beomseok/sandbox:/workspace \
  -w /workspace \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint /bin/sh \
  opencode -lc 'apk add --no-cache curl >/dev/null && curl -v http://host.docker.internal:11434/'
```
If it does not respond within timeout, your firewall could block the connection. Try the command as follows:
```bash
sudo ufw allow from 172.17.0.0/16 to any port 11434
```