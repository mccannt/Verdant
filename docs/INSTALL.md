# INSTALL

## Requirements
- Node.js 20+
- npm 10+
- Chromium dependencies for Playwright (auto-installed via Playwright install command)

## Local Dev (Mac/Linux/Windows)
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install Playwright Chromium:
   ```bash
   npx playwright install chromium
   ```
4. Start UI + runner with one command:
   ```bash
   npm run dev
   ```
5. Open `http://localhost:5173`.

## Production Build (without Docker)
1. Build all workspaces:
   ```bash
   npm run build
   ```
2. Start runner (serves API + static UI):
   ```bash
   npm run start
   ```
3. Open `http://localhost:8787`.

## Docker
1. Build image:
   ```bash
   docker build -t verdant .
   ```
2. Run:
   ```bash
   docker run --rm -p 8787:8787 verdant
   ```
3. Open `http://localhost:8787`.

## Environment
Copy `.env.example` to `.env` and adjust as needed.

- `PORT`: Runner port.
- `VERDANT_MASTER_KEY` (optional): Stable encryption secret for API key vault. If omitted, runner generates a local secret file under `apps/runner/.data/master.key`.

## Troubleshooting
- `No API key provided/stored`: Save a provider key from the UI or include an ephemeral key in the run form.
- `Failed to fetch Google Sheet CSV`: Confirm sheet is public read-only and URL is a valid Google Sheets link.
- `Survey page loaded but no visible question/input`: The survey may use non-accessible widgets outside supported scope.
- `Playwright browser not found`: run `npx playwright install chromium`.
- Slow/unstable flows: switch to `reliable` speed mode and enable screenshots.
