# Playwright MCP Docker Integration Error

## When
March 22, 2026 - During Docker container setup for Playwright MCP integration with opencode agent. 

## Related files
- packages/opencode/Dockerfile: docker build file that build opencode and preinstall playwright.
- configuration_template/opencode.json: this is a opencode configuration file.

## Error
```
playwright MCP error -32000: Connection closed
```

When trying to use Playwright browser tools in the opencode agent running in Docker, the browser fails to launch with:
```
chrome_crashpad_handler: --database is required
SIGTRAP signal
```

## Root Cause
Chromium's crashpad handler is crashing due to sandbox/permission restrictions in the Docker container environment. The handler tries to create a crash database but fails due to:
1. Container security restrictions
2. Missing or inaccessible crash dump directories
3. Conflicting sandboxing flags

## What We Tried

### 1. Dockerfile User & Permissions Fix
- Uncommented user creation and browser ownership fixes in Dockerfile
- Created `opencode` user and fixed `/ms-playwright` directory ownership
- **Result:** ❌ Browser still crashed with crashpad errors

### 2. Chromium Sandbox Flags
Added aggressive sandbox/crash handling flags to `PLAYWRIGHT_CHROMIUM_ARGS`:
```
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
--disable-crash-reporter
--no-zygote
--crash-dumps-dir=/tmp
--disable-breakpad
--disable-gpu
--single-process
```
- **Result:** ❌ Crashpad handler still failed to initialize

### 3. Environment Variables
Added environment variables to disable crash handling:
```
CHROME_HEADLESS_MODE=1
CHROME_NO_SANDBOX=1
CRASHPAD_HANDLER_ARGS=""
```
- **Result:** ❌ No effect, connection still closed

### 4. Docker Image Approach (First Attempt)
Changed MCP command to use Microsoft's Docker image:
```json
"command": ["docker", "run", "-i", "--rm", "--init", "mcr.microsoft.com/playwright/mcp"]
```
- **Result:** ❌ Docker socket not accessible in opencode container

### 5. Microsoft Playwright Base Image
Switched Dockerfile base image from `ubuntu:24.04` to `mcr.microsoft.com/playwright:v1.37.0-focal`
- Removed duplicate installs (Node, Python, browsers)
- Kept only `playwright-mcp` installation
- Updated config to use local `playwright-mcp` command
- **Result:** ❌ Still getting connection closed error

## Current Status
- Dockerfile: Using Microsoft Playwright base image v1.37.0
- Config: Using local `playwright-mcp` command
- Issue: MCP connection still closes, browser won't launch
- Need: Further investigation into why Microsoft base image approach isn't working

## Next Steps to Try
1. Check if `playwright-mcp` is actually installed in the Microsoft base image
2. Verify browser binaries exist and are accessible
3. Check MCP server logs for detailed error messages
4. Consider using a different Playwright version
5. Debug MCP connection directly without opencode agent
6. Check if there's a network/IPC issue between opencode and MCP server
