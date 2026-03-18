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

---

## Option B — Deploy on an Azure server

This guide is for deploying the MCP on an Azure virtual machine so anyone in your organization can use it without running anything locally. Claude Desktop will connect to the server over the internet.

### What you need

- An Azure Linux virtual machine (Ubuntu 22.04 LTS recommended) with:
  - Port **3000** open in the Network Security Group (NSG) — your Azure admin can do this
  - A public IP address or DNS name
- SSH access to the VM

---

### Part 1 — Set up the server

SSH into the VM and run these commands one by one.

**1. Install Node.js 20**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v20.x.x
```

**2. Install Git**

```bash
sudo apt-get install -y git
```

**3. Download the code**

```bash
cd ~
git clone https://github.com/uuteen-alyyn/vihrea-vaalidata-tilastotAPI-MCP.git
cd vihrea-vaalidata-tilastotAPI-MCP
```

**4. Install dependencies and build**

```bash
npm install
npm run build
```

No errors means success. A `dist/` folder will appear.

**5. Install PM2 (process manager — keeps the server running after you log out)**

```bash
sudo npm install -g pm2
```

**6. Start the MCP server**

```bash
pm2 start npm --name "fi-election-mcp" -- run start:http
pm2 save
pm2 startup   # follow the printed instruction to make it survive reboots
```

**7. Verify it is running**

```bash
pm2 status
```

You should see `fi-election-mcp` with status `online`.

Test from the server itself:

```bash
curl -s http://localhost:3000/mcp -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  | head -c 200
```

You should get a JSON response (not an error). If so, the server is working.

**8. Open port 3000 in Azure**

In the Azure portal:
1. Go to your VM → **Networking** → **Network security group**
2. Click **Add inbound port rule**
3. Set: Protocol = TCP, Destination port = **3000**, Action = Allow, Priority = 200, Name = `mcp-3000`
4. Click **Add**

---

### Part 2 — Connect Claude Desktop to the server

Do this on each computer that wants to use the MCP.

**1. Find your server's address**

In the Azure portal, go to your VM and copy its **Public IP address** (or DNS name if you set one up). It will look like `20.123.45.67`.

**2. Open Claude Desktop's config file**

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Open it in any text editor. Create it if it does not exist.

**3. Add the remote MCP server**

Replace `YOUR_SERVER_IP` with your VM's public IP address:

```json
{
  "mcpServers": {
    "fi-election-data": {
      "url": "http://YOUR_SERVER_IP:3000/mcp"
    }
  }
}
```

**Example:**

```json
{
  "mcpServers": {
    "fi-election-data": {
      "url": "http://20.123.45.67:3000/mcp"
    }
  }
}
```

**4. Restart Claude Desktop**

Fully quit and reopen Claude Desktop. You should see a tools icon (hammer) in the chat input. Click it to confirm the election data tools are listed.

**You're done.** The MCP is now running on Azure and Claude Desktop connects to it remotely.

---

### Managing the server (reference)

| Task | Command |
|---|---|
| Check server status | `pm2 status` |
| View server logs | `pm2 logs fi-election-mcp` |
| Restart server | `pm2 restart fi-election-mcp` |
| Stop server | `pm2 stop fi-election-mcp` |
| Update to latest code | `cd ~/vihrea-vaalidata-tilastotAPI-MCP && git pull && npm run build && pm2 restart fi-election-mcp` |

---

## Data coverage

| Election type | Years with party data | Years with candidate data |
|---|---|---|
| Parliamentary | 1983–2023 | 2019, 2023 |
| Municipal | 1976–2025 | 2025 |
| Regional (aluevaalit) | 2022, 2025 | 2025 |
| EU Parliament | 1996–2024 | 2019, 2024 |
| Presidential | — | 2024 (rounds 1 & 2) |

Data source: [Tilastokeskus PxWeb API](https://pxdata.stat.fi/PXWeb/pxweb/fi/StatFin/)
