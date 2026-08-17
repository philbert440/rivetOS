import { webSpeechAvailable } from './speech'

function browserDictation(): DesktopCapabilities['dictation'] {
  return webSpeechAvailable()
    ? { available: true, engine: 'web-speech', onDevice: false }
    : { available: false, engine: 'none', onDevice: false, reasonCode: 'no-web-speech' }
}

const browserCapabilities: DesktopCapabilities = {
  host: {
    platform: "other",
    label: "Browser",
    session: "unknown",
    packaged: false,
  },
  windowChrome: "native",
  screenPreview: {
    available: false,
    interaction: "none",
    reasonCode: "desktop-app-required",
  },
  get dictation() {
    return browserDictation()
  },
  localComputer: {
    available: false,
    support: "unsupported",
    reasonCode: "desktop-app-required",
  },
};

let cached: DesktopCapabilities | null = null;

export function browserDesktopCapabilities(): DesktopCapabilities {
  return { ...browserCapabilities, dictation: browserDictation() };
}

export function initialDesktopCapabilities(): DesktopCapabilities {
  const platform = window.ogb?.platform;
  if (!platform) return browserDesktopCapabilities();
  const isMac = platform === "darwin";
  return {
    ...browserCapabilities,
    host: {
      ...browserCapabilities.host,
      platform: platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other",
      label: platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : "Desktop",
    },
    windowChrome: isMac ? "mac-inset" : "native",
    dictation: isMac
      ? { available: true, engine: "apple-speech", onDevice: true }
      : browserDictation(),
  };
}

export async function loadDesktopCapabilities(): Promise<DesktopCapabilities> {
  if (cached) return cached;
  if (!window.ogb?.getCapabilities) return browserDesktopCapabilities();
  try {
    cached = await window.ogb.getCapabilities();
  } catch {
    cached = browserDesktopCapabilities();
  }
  if (!cached.dictation.available && webSpeechAvailable()) {
    cached = { ...cached, dictation: browserDictation() };
  }
  return cached;
}
