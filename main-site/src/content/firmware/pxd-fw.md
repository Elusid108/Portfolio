---
name: pxd-fw
version: 1.4.2
date: 2026-08-01
targets: ["PXD-8", "PXD-16", "PXD-Mini"]
downloadUrl: https://github.com/Elusid108/pxd-fw/releases/latest
sha256: "0000000000000000000000000000000000000000000000000000000000000000"
webInstallerManifest: https://chrismooredesigns.com/flash/pxd-fw/manifest.json
repo: https://github.com/Elusid108/pxd-fw
ota: true
---
- Art-Net sync packet support
- Per-output color order override
- Fix: DDP frames larger than 1,440 bytes were dropped on PXD-Mini
