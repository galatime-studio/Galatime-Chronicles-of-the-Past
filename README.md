<p align="center">
  <img src="apps/desktop/src-tauri/icons/128x128.png" alt="GalaTime - Chronicles of the Past logo" width="128" height="128">
</p>

<h1 align="center">GalaTime - Chronicles of the Past</h1>

<p align="center"><strong>A game built with React + Tauri + Tailwind CSS.</strong><br>
A cross-platform game powered by modern web tech and Rust.<br>
Windows, macOS and Linux.</p>

<p align="center">
  <a href="https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/releases/latest"><img src="https://img.shields.io/badge/Download-v0.1.0-6D72CA?style=for-the-badge" alt="Download GalaTime"></a>
  <a href="https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/stargazers"><img src="https://img.shields.io/github/stars/galatime-studio/Galatime-Chronicles-of-the-Past?style=for-the-badge&color=24292f" alt="GitHub stars"></a>
  <a href="https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past"><img src="https://img.shields.io/github/repo-size/galatime-studio/Galatime-Chronicles-of-the-Past?style=for-the-badge&color=24292f" alt="Repo size"></a>
</p>

<p align="center">
  <a href="#disclosure">Disclosure</a> ·
  <a href="#download"><strong>Download</strong></a> ·
  <a href="#how-to-install-and-run"><strong>How to Install and Run</strong></a> ·
  <a href="#folder-structure">Folder Structure</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#forgers--customization">Forgers & Customization</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Language-TypeScript-6D72CA" alt="TypeScript">
  <img src="https://img.shields.io/badge/Framework-React%20%2B%20Tauri-8F92D6" alt="React + Tauri">
  <img src="https://img.shields.io/badge/Styling-Tailwind%20CSS-C5B4E9" alt="Tailwind CSS">
  <img src="https://img.shields.io/badge/Windows-10%20%C2%B7%2011-24292f" alt="Windows 10 and 11">
  <img src="https://img.shields.io/badge/macOS-11%2B%20%C2%B7%20Apple%20Silicon%20%C2%B7%20Intel-24292f" alt="macOS 11 or newer">
  <img src="https://img.shields.io/badge/Linux-x86__64-24292f" alt="Linux x86_64">
  <img src="https://img.shields.io/badge/status-WIP-FFBB00" alt="Work In Progress">
  <img src="https://img.shields.io/badge/license-GPLv3-24292f" alt="License GPLv3">
</p>

## Disclosure

> [!IMPORTANT]  
> **AI Disclosure:** This project was developed with the assistance of Artificial Intelligence **for code only**. But not for any other aspect of the project (e.g., design, art, story, logic, documentation, etc.).  
> We disclose this upfront for transparency, especially for those who object to the use of AI in software development.  
> If you choose not to play due to AI assistance in code, we fully respect that decision.

## Download

> [!NOTE]
> **v0.1.0 — early access.** The core loop is playable (story scenes, dialogue, turn-based combat, skill trees, inventory), but this is an early build: content is incomplete, balance is in flux and rough edges are expected.

### Windows (10/11, x64)

- **[Download the installer v0.1.0](https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/releases/download/v0.1.0/Galatime.-.Chronicles.of.the.Past_0.1.0_x64-setup.exe)** — NSIS `.exe`, 46 MB. No extra runtime required.
- **[Download the MSI v0.1.0](https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/releases/download/v0.1.0/Galatime.-.Chronicles.of.the.Past_0.1.0_x64_en-US.msi)** — 47 MB, for those who prefer MSI packages.
- **[All releases](https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/releases)** — every published build, with notes.

> [!WARNING]
> The build is not code-signed, so Windows SmartScreen may warn on first launch. Choose **More info → Run anyway** if you trust the source.

> [!NOTE]
> macOS and Linux builds are not published yet. You can run the game from source — see below.

## How to Install and Run

### From the installer (Windows)

1. Download the `.exe` from the [latest release](https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past/releases/latest).
2. Run it and follow the installer. It installs per user; no admin rights are required.
3. Launch **Galatime - Chronicles of the Past** from the Start Menu or the desktop shortcut.

### From source

1. **Clone the repo**
    ```bash
    git clone https://github.com/galatime-studio/Galatime-Chronicles-of-the-Past.git
    cd Galatime-Chronicles-of-the-Past
    ```

2. **Install dependencies**
    ```bash
    npm install
    ```

3. **Run the app**

    ```bash
    npm run dev:desktop     # Run as a desktop app in dev mode
    npm run dev:web         # Run as a web app in dev mode
    npm run build           # Build the desktop app for production
    ```


## Folder Structure

```
apps/desktop/src/         Main app (React + TypeScript)
apps/desktop/src-tauri/   Tauri/Rust configuration and native code
apps/desktop/public/      Static assets (sprites, audio, fonts)
packages/                 Shared types and game configuration
docs/                     Design and system documentation
mockups/                  Forgers used to create engine files
```

## Documentation

> [!NOTE]
> **Work in progress.** Design and system notes live in [`docs/`](docs/) — skill trees, combat, AI, missions and scenes.

## Forgers & Customization

```
mockups/                  forgers used to create different engine files.
apps/desktop/src/data/    dialogues, skills, and other game data.
```

> [!NOTE]  
> **Work in progress.** More detailed customization guides will be added soon.