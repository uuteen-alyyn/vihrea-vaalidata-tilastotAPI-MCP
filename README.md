# FI Election Data MCP

A Model Context Protocol (MCP) service that gives Claude structured access to Finnish election data from Tilastokeskus (Statistics Finland). Covers parliamentary, municipal, regional, EU parliament, and presidential elections.

---

## Option A — Run locally on your own computer

Connect the MCP to Claude Desktop running on your own machine. No server needed.

### What you need

- [Claude Desktop](https://claude.ai/download) installed
- [Node.js 20 or later](https://nodejs.org/) installed
- [Git](https://git-scm.com/downloads) installed

### Steps

**1. Download the code**

Open a terminal and run:

```bash
git clone https://github.com/uuteen-alyyn/vihrea-vaalidata-tilastotAPI-MCP.git
cd vihrea-vaalidata-tilastotAPI-MCP
```

**2. Install dependencies and build**

```bash
npm ci
npm run build
```

You should see no errors. A `dist/` folder will appear.

**3. Find the full path to the project folder**

You need the absolute path to the folder. Run this:

```bash
# On Mac/Linux:
pwd

# On Windows (PowerShell):
Get-Location
```

Copy the output — you'll need it in the next step.

**4. Open Claude Desktop's config file**

The config file location depends on your operating system:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Open that file in any text editor. If the file does not exist, create it.

**5. Add the MCP server**

Paste the following into `claude_desktop_config.json`, replacing `/FULL/PATH/TO/PROJECT` with the path you copied in step 3:

```json
{
  "mcpServers": {
    "fi-election-data": {
      "command": "node",
      "args": ["/FULL/PATH/TO/PROJECT/dist/index.js"]
    }
  }
}
```

**Example on macOS** (if you cloned into your home folder):

```json
{
  "mcpServers": {
    "fi-election-data": {
      "command": "node",
      "args": ["/Users/yourname/vihrea-vaalidata-tilastotAPI-MCP/dist/index.js"]
    }
  }
}
```

> If you already have other MCP servers listed in the config, add `"fi-election-data": { ... }` alongside them inside the `"mcpServers"` block.

**6. Restart Claude Desktop**

Fully quit and reopen Claude Desktop. You should now see a tools icon (hammer) in the chat input. Click it to confirm the election data tools are listed.

**You're done.** Ask Claude something like: *"Which party got the most votes in Helsinki in the 2023 parliamentary election?"*

For best results, add a system prompt to Claude Desktop that describes the election data context. See [system_prompt.md](system_prompt.md) in this project for a ready-made system prompt to paste in.

---

## Option B — Deploy on Azure App Service

This guide deploys the MCP on Azure App Service (Free or Basic tier) so anyone in your organization can use it without running anything locally.

> **Note:** Azure App Service terminates TLS at the infrastructure level. The Node.js process serves plain HTTP internally; Azure provides the public HTTPS endpoint automatically. No TLS configuration is needed in the app.

### What you need

- An Azure account with permission to create App Service resources
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli) installed locally (or use Azure Cloud Shell)

### Deploy

**1. Clone and build locally**

```bash
git clone https://github.com/uuteen-alyyn/vihrea-vaalidata-tilastotAPI-MCP.git
cd vihrea-vaalidata-tilastotAPI-MCP
npm ci && npm run build
```

**2. Create a resource group and App Service plan**

```bash
az group create --name fi-election-rg --location northeurope
az appservice plan create --name fi-election-plan --resource-group fi-election-rg \
  --sku F1 --is-linux
```

**3. Create the web app**

```bash
az webapp create --name YOUR_APP_NAME --resource-group fi-election-rg \
  --plan fi-election-plan --runtime "NODE:20-lts"
```

Replace `YOUR_APP_NAME` with a globally unique name (e.g. `fi-election-mcp-yourorg`).

**4. Set the start command**

```bash
az webapp config set --name YOUR_APP_NAME --resource-group fi-election-rg \
  --startup-file "node dist/server-http.js"
```

**5. Deploy the code**

```bash
az webapp up --name YOUR_APP_NAME --resource-group fi-election-rg
```

**6. Verify it is running**

```bash
curl -s https://YOUR_APP_NAME.azurewebsites.net/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  | head -c 200
```

You should get a JSON response. If so, the server is working.

---

### Connect Claude Desktop to the App Service

**1. Open Claude Desktop's config file**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

**2. Add the remote MCP server**

```json
{
  "mcpServers": {
    "fi-election-data": {
      "url": "https://YOUR_APP_NAME.azurewebsites.net/mcp"
    }
  }
}
```

**3. Restart Claude Desktop**

Fully quit and reopen. You should see a tools icon (hammer) in the chat input.

**You're done.** The MCP is running on Azure App Service and Claude Desktop connects to it remotely.

---

### Managing the deployment (reference)

| Task | Command |
|---|---|
| View logs | `az webapp log tail --name YOUR_APP_NAME --resource-group fi-election-rg` |
| Restart app | `az webapp restart --name YOUR_APP_NAME --resource-group fi-election-rg` |
| Update to latest code | `git pull && npm run build && az webapp up --name YOUR_APP_NAME --resource-group fi-election-rg` |

---

## Data coverage

| Election type | Years with party data | Years with candidate data |
|---|---|---|
| Parliamentary | 1983–2023 | 2007, 2011, 2015, 2019, 2023 |
| Municipal | 1976–2025 | 2021, 2025 |
| Regional (aluevaalit) | 2022, 2025 | 2025 |
| EU Parliament | 1996–2024 | 2019, 2024 |
| Presidential | — | 2024 (rounds 1 & 2) |

Data source: [Tilastokeskus PxWeb API](https://pxdata.stat.fi/PXWeb/pxweb/fi/StatFin/)

---

## MCP Resources

The server exposes three read-only reference resources the LLM can read on demand. These keep tool descriptions lean and are always derived live from the data registry.

| Resource URI | Contents |
|---|---|
| `election://coverage` | Which election types and years have party, candidate, and turnout data |
| `election://unit-keys` | Valid `unit_key` values (vaalipiiri / hyvinvointialue) by election type and year |
| `election://metrics` | Definitions and formulas for all computed metrics: ENP, Pedersen index, overperformance, etc. |

Claude reads these on demand when it needs to check data availability, validate a unit key, or understand a metric formula.

---

## MCP Prompts

The server registers two parameterized workflow prompts users can invoke as slash commands in Claude Desktop:

| Prompt | Arguments | What it does |
|---|---|---|
| `analyze_candidate` | `candidate_name`, `election_type`, `year`, `unit_key` (optional) | Full workflow: resolve candidate → get results → analyze profile |
| `compare_parties` | `party_ids`, `election_type`, `years`, `focus` (optional) | Cross-election party comparison with ENP and geographic breakdown |

In Claude Desktop, invoke these via the **+** or slash command menu.

---

## System prompt

For reliable LLM-driven analysis, add a system prompt to Claude Desktop that explains Finnish electoral context and guides tool selection. Without it, the model may guess area codes, omit required resolution steps, or misinterpret metrics.

A ready-made system prompt is in [system_prompt.md](system_prompt.md).

**How to add it in Claude Desktop:**
1. Open Claude Desktop → Settings → Model
2. Paste the contents of `system_prompt.md` into the **System Prompt** field
3. Save and start a new conversation

---

## Known limitations

| Area | Status |
|---|---|
| Election outcome (elected/varalla/not elected) | Available for parliamentary 2023, municipal 2025, regional 2025 via `analyze_candidate_profile`. Not available for EU or presidential. |
| ENP (Effective Number of Parties) | Computed from votes — exposed in `analyze_party_profile` (`election_enp`) and `get_area_profile` (`area_enp`). Note: vote-ENP differs from seat-ENP in proportional systems. |
| Incumbent flag | Available for municipal and regional elections only (not parliamentary). Not yet exposed as a tool output. |
| Presidential party data | Not published by Tilastokeskus — only individual candidate vote totals. |
| Regional candidate data | 2025 only. Tilastokeskus has no candidate-level tables for aluevaalit 2022. |
| Parliamentary candidate data (2007 / 2011) | These elections used 15 vaalipiiri (before the 2012 boundary reform). Valid unit keys differ from 2015+: use `kymi`, `etela-savo`, `pohjois-savo`, `pohjois-karjala` instead of `kaakkois-suomi` / `savo-karjala`. |
| Vote transfer | `estimate_vote_transfer_proxy` is a structural area co-movement indicator, not a direct measurement of individual voter movement. Individual-level data is not available in aggregate statistics. |
