## New Feature: `/simulate` (LLM-as-a-user)
[README_original.md](README_original.md)
- Use `/simulate` to have an LLM act as the user (LLM-as-a-user) and propose the next task.
- The **LLM-as-a-user** ask questions based on external context and conversation history.
- Configure simulator model, max turns, and an optional external context path (file or directory).
- The prompt footer shows the simulation turn/status and, when set, the external context path for clarity.
- Added or modified files from the source code:
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
cd ..
``

### 2. Use Ollama inside the sandbox
Start Ollama on the host (all interfaces):
```bash
OLLAMA_CONTEXT_LENGTH=200000 OLLAMA_HOST=0.0.0.0 ollama serve
```

### 3. Make a documents as external context
1. Write a markdown file that includes software functional requirements, technology stacks, and data modeling.
2. Place the markdown files in the `./external`
3. The first line of the markdown file should be the title of the project. For example:
``` md
# Stock Trading Web Application
## Functional Requirement:
- 1.1 Create account: The system shall allow users to create an account using an email address and password.
- 1.2 Authenticate user: The system shall allow users to log in and log out using valid credentials.
- 1.3 Secure passwords: The system shall securely hash and store user passwords.
- 1.4 Prevent duplicates: The system shall prevent registration with duplicate email addresses.
...
```
  - In this case, "stock trading web application" would be the title. When you run `/simulate`, the llm-as-a-user write the first prompt, "Develop a stock trading web application".
4. Set `configuration_template/simulation.json`:
```json
{
  "simulator_model": "gpt-oss:20b",
  "agent_model": "qwen3-coder:30b",
  "max_turns": 100,
  "external_context": "/docs/req_docs.md"
}
```


### 4. Run OpenCode with host access to Ollama:
```bash
  docker run -it --rm \
    -v /home/beomseok/sandbox/qwen3_1:/workspace \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v ./configuration_template:/.opencode \
    -v ./external:/docs:ro \
    -w /workspace \
    --add-host=host.docker.internal:host-gateway \
    -e SIMULATION_CONFIG_JSON="$(jq -c . configuration_template/simulation.json)" \
    -e OLLAMA_HOST="http://host.docker.internal:11434/v1" \
    opencode
  ```

### 5. Troubleshoot connectivity
- Verify the sandbox can reach Ollama:
  ```bash
  docker run -it --rm \
  -v /home/beomseok/sandbox:/workspace \
  -v ./configuration_template:/.opencode \
  -v ./external:/docs \
  -w /workspace \
  --add-host=host.docker.internal:host-gateway \
  --entrypoint /bin/sh \
  opencode
  ```
- If it times out, adjust firewall rules (example):
  ```bash
  sudo ufw allow from 172.17.0.0/16 to any port 11434
  ```


## FAQ
### 1. How the llm-as-a-user reacts in response to the agent's question?
1. Agent asks a question → backend emits question.asked.
2. simulate.tsx listens for that event.
3. It builds answers:
  - For each question, it checks options.
  - If custom answers are allowed, the simulator always chooses “type your own answer”.question text, it picks that.
  - It calls the LLM (Simulate.generateAnswer) using the question text + external context to produce a custom reply, then submits that as the answer.
4. It may take a few second to process the generated answer.
