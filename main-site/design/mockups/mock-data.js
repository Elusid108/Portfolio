// Placeholder catalogue shared by all five mockups. Prices and specs are
// illustrative. Mirrors src/content/ in the Astro project.
window.MOCK = {
  links: {
    portfolio: 'https://chrismoore.me',
    github: 'https://github.com/Elusid108',
    contact: 'https://chrismoore.me/#contact',
  },
  families: [
    {
      id: 'pixeldecode',
      name: 'PixelDecode',
      category: 'Hardware',
      color: 'text-green-400',
      tagline: 'ESP32-S3 pixel decoders. Art-Net, sACN and DDP in, WS281x / SK6812 / APA102 out. No PC in the loop.',
      products: ['PXD-8', 'PXD-16', 'PXD-MINI'],
    },
    {
      id: 'pixelpilot',
      name: 'PixelPilot',
      category: 'Systems',
      color: 'text-blue-400',
      tagline: 'A Raspberry Pi controller that finds every board on the network, schedules shows and pushes firmware to the fleet.',
      products: ['PP-HAT'],
    },
    {
      id: 'desktop',
      name: 'PixelPilot Desktop',
      category: 'Software',
      color: 'text-purple-400',
      tagline: 'Companion PC app for mapping pixels from a photo, live preview and one-click flashing. Windows, macOS, Linux.',
      products: [],
    },
  ],
  products: [
    {
      sku: 'PXD-8', name: 'PXD-8', family: 'pixeldecode', price: 89, featured: true,
      summary: 'Eight fused, level-shifted outputs. Up to 4,096 pixels at 40 fps.',
      specs: { MCU: 'ESP32-S3, 8 MB flash', Outputs: '8 × 5 V level-shifted', 'Max pixels': '4,096 (512/output @ 40 fps)', Protocols: 'Art-Net, sACN, DDP, WLED-compatible', Power: '5–24 V DC screw terminal · USB-C console', Size: '80 × 50 mm, M3 corners' },
      variants: ['8 ch'],
    },
    {
      sku: 'PXD-16', name: 'PXD-16', family: 'pixeldecode', price: 149,
      summary: 'Sixteen outputs, dual power domains, RJ45 for installs that can’t rely on Wi-Fi.',
      specs: { MCU: 'ESP32-S3, 16 MB flash', Outputs: '16 × 5 V level-shifted', 'Max pixels': '8,192', Network: 'Wi-Fi + 100 Mb Ethernet', Power: '2 × 5–24 V DC domains' },
      variants: ['16 ch'],
    },
    {
      sku: 'PXD-MINI', name: 'PXD-Mini', family: 'pixeldecode', price: 39,
      summary: 'Two outputs, USB-C powered. For a single lamp, sign or desk piece.',
      specs: { MCU: 'ESP32-S3', Outputs: '2 × 5 V level-shifted', 'Max pixels': '1,024', Power: 'USB-C 5 V', Size: '40 × 30 mm' },
      variants: ['2 ch'],
    },
    {
      sku: 'PP-HAT', name: 'PixelPilot HAT + image', family: 'pixelpilot', price: 69,
      summary: 'Raspberry Pi HAT with RTC, status OLED and a pre-built SD card running PixelPilot OS.',
      specs: { Fits: 'Raspberry Pi 4 / 5', Extras: 'RTC · 0.96" OLED · 2 buttons · fan header', Software: 'PixelPilot OS on 32 GB SD' },
      variants: ['Pi 4', 'Pi 5'],
    },
    {
      sku: 'BUNDLE-START', name: 'Starter bundle', family: 'pixeldecode', price: 129, bundle: true,
      summary: 'PXD-8 + 5 V 10 A supply + 3 m of pre-wired pixel tails. Everything for a first 16 × 16 wall.',
      specs: {},
      variants: ['Bundle'],
    },
  ],
  firmware: [
    { name: 'pxd-fw', version: '1.4.2', date: '2026-08-01', targets: ['PXD-8', 'PXD-16', 'PXD-Mini'], ota: true, web: true,
      sha256: '9f2c…e41b',
      notes: ['Art-Net sync packet support', 'Per-output color order override', 'Fix: DDP frames > 1,440 bytes dropped on PXD-Mini'] },
    { name: 'pxd-fw', version: '1.4.1', date: '2026-06-14', targets: ['PXD-8', 'PXD-16', 'PXD-Mini'], ota: true, web: true,
      sha256: '31aa…07c9',
      notes: ['sACN priority handling', 'Captive portal on first boot'] },
    { name: 'PixelPilot OS', version: '0.9.1', date: '2026-07-12', targets: ['PP-HAT'], ota: true, web: false,
      sha256: 'c0de…88f1',
      notes: ['Fleet OTA for pxd-fw 1.4.x', 'Show scheduler: sunset/sunrise triggers'] },
  ],
  software: [
    { name: 'PixelPilot Desktop', version: '0.9.0', platforms: ['Windows', 'macOS', 'Linux'], summary: 'Map pixels from a photo, preview live, flash boards.', url: 'https://github.com/Elusid108' },
    { name: 'LithoLab', platforms: ['Web'], summary: 'Photo → printable color lithophane.', url: 'https://elusid108.github.io/LithoLab/' },
    { name: 'LithoPalletGen', platforms: ['Web'], summary: 'Filament palettes and swap heights for multi-color lithophanes.', url: 'https://elusid108.github.io/LithoPalletGen/' },
    { name: 'BorderBuilder', platforms: ['Web'], wip: true, summary: 'Frames and borders for lithophane prints.', url: 'https://elusid108.github.io/BorderBuilder/' },
  ],
  services: [
    { name: 'Custom color lithophanes', from: 45, summary: 'Send a photo, get a backlit full-color lithophane printed on a Bambu X1C. Lamp bases with a PXD-Mini inside available.', tools: ['LithoLab', 'LithoPalletGen', 'BorderBuilder'] },
    { name: 'Custom PCBA design', summary: 'Schematic, layout and small-run assembly for pixel and lighting control boards.' },
    { name: 'Install & commissioning', summary: 'On-site pixel mapping, network design and show programming for permanent installs.' },
  ],
};

window.MOCK.productBySku = (sku) => window.MOCK.products.find((p) => p.sku === sku);
