/**
 * Functions that are serialised and executed *inside* the page.
 *
 * Hard rules for everything in this file:
 *
 *   1. Every exported function must be fully self-contained. Puppeteer sends
 *      `Function.prototype.toString()` to the browser, so no module scope, no
 *      imports and no closures over outer values may be used.
 *   2. Return values must be JSON-serialisable.
 *   3. Everything is bounded — a hostile or enormous page must never be able to
 *      blow up the Worker.
 *
 * The same sources are executed under jsdom in the test suite, which is what
 * guarantees rule 1 keeps holding.
 */

export interface ChallengeSignalsPayload {
  title: string;
  text: string;
  html: string;
  status: number | null;
  readyState: string;
  hasPasswordField: boolean;
  hasCaptchaWidget: boolean;
  hasConsentBanner: boolean;
  iframeHosts: string[];
}

export interface PageStateOptions {
  maxTextChars: number;
  maxLinks: number;
  includeHtml: boolean;
  maxHtmlChars: number;
  maxInteractive: number;
  maxHeadings: number;
  maxJsonLd: number;
  maxRawStateChars: number;
  selector?: string | null;
}

export interface PageLink {
  text: string;
  href: string;
  title?: string;
  rel?: string;
}

export interface InteractiveElement {
  ref: string;
  tag: string;
  role: string | null;
  type: string | null;
  name: string;
  text: string;
  placeholder: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean | null;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface PageStatePayload {
  url: string;
  title: string;
  lang: string;
  readyState: string;
  charset: string | null;
  text: string;
  textLength: number;
  html: string | null;
  meta: Record<string, string>;
  links: PageLink[];
  headings: string[];
  interactive: InteractiveElement[];
  forms: { count: number; passwordFields: number; fileInputs: number };
  media: { videoCount: number; audioCount: number; imageCount: number; canvasCount: number };
  scroll: { x: number; y: number; viewportWidth: number; viewportHeight: number; documentWidth: number; documentHeight: number };
  signals: {
    hasPasswordField: boolean;
    hasCaptchaWidget: boolean;
    hasConsentBanner: boolean;
    iframeHosts: string[];
  };
  jsonLd: string[];
  rawStates: { universal: string | null; sigi: string | null };
  selector: string | null;
  selectorMatched: boolean;
}

export interface MediaElementInfo {
  index: number;
  tag: "video" | "audio";
  src: string | null;
  currentSrc: string | null;
  sources: string[];
  poster: string | null;
  durationSeconds: number | null;
  currentTime: number | null;
  readyState: number;
  networkState: number;
  paused: boolean;
  muted: boolean;
  loop: boolean;
  autoplay: boolean;
  controls: boolean;
  crossOrigin: string | null;
  preload: string | null;
  attrWidth: number | null;
  attrHeight: number | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
  bufferedSeconds: number | null;
  textTracks: number;
  /** True when the element is wired to Encrypted Media Extensions (DRM). */
  protectedMedia: boolean;
  errorCode: number | null;
  errorMessage: string | null;
  playsInline: boolean;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface ImageCandidate {
  src: string;
  alt: string | null;
  attrWidth: number | null;
  attrHeight: number | null;
  naturalWidth: number | null;
  naturalHeight: number | null;
}

export interface MediaOptions {
  maxMediaElements: number;
  maxImages: number;
  maxRawStateChars: number;
  selector?: string | null;
}

export interface MediaPayload {
  url: string;
  title: string;
  videos: MediaElementInfo[];
  audios: MediaElementInfo[];
  images: ImageCandidate[];
  meta: Record<string, string>;
  jsonLd: string[];
  rawStates: { universal: string | null; sigi: string | null };
  /** True when the page exposes at least one HTML5 <video> element. */
  hasVideoElement: boolean;
  downloadedMedia: false;
}

export interface VideoPrepareOptions {
  index: number;
  selector?: string | null;
  muted: boolean;
}

export interface VideoPrepareResult {
  found: boolean;
  durationSeconds: number | null;
  intrinsicWidth: number | null;
  intrinsicHeight: number | null;
  readyState: number;
  protectedMedia: boolean;
  errorMessage: string | null;
  rect: { x: number; y: number; width: number; height: number } | null;
}

export interface SeekOptions {
  index: number;
  selector?: string | null;
  time: number;
  timeoutMs: number;
}

export interface SeekResult {
  ok: boolean;
  currentTime: number | null;
  readyState: number;
  error: string | null;
}

export interface InteractiveOptions {
  maxElements: number;
  reset: boolean;
}

/**
 * Minimal signal collection used by the challenge detector.
 */
export function collectChallengeSignals(): ChallengeSignalsPayload {
  const doc = document;
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const hasAny = (selectors: string[]): boolean => {
    for (const selector of selectors) {
      try {
        if (doc.querySelector(selector)) return true;
      } catch {
        /* invalid selector for this document — ignore */
      }
    }
    return false;
  };
  const captchaSelectors = [
    ".g-recaptcha",
    ".h-captcha",
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='turnstile']",
    "iframe[src*='arkoselabs']",
    "iframe[src*='captcha-delivery']",
    "[class*='captcha']",
    "[id*='captcha']",
  ];
  const consentSelectors = [
    "#onetrust-banner-sdk",
    "#CybotCookiebotDialog",
    "#didomi-popup",
    "#sp-message-container",
    "[class*='cookie-banner']",
    "[class*='consent']",
    "[id*='consent']",
    "[aria-label*='cookie']",
  ];
  const iframeHosts: string[] = [];
  const frames = doc.querySelectorAll("iframe");
  for (let i = 0; i < frames.length && iframeHosts.length < 20; i++) {
    const src = frames[i].getAttribute("src");
    if (!src) continue;
    try {
      const host = new URL(src, location.href).hostname;
      if (host && iframeHosts.indexOf(host) === -1) iframeHosts.push(host);
    } catch {
      /* ignore unparsable src */
    }
  }
  return {
    title: clean(doc.title),
    text: String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").slice(0, 20000),
    html: "",
    status: null,
    readyState: doc.readyState,
    hasPasswordField: doc.querySelectorAll('input[type="password"]').length > 0,
    hasCaptchaWidget: hasAny(captchaSelectors),
    hasConsentBanner: hasAny(consentSelectors),
    iframeHosts,
  };
}

/**
 * Full page read: text, metadata, links, interactive elements and the raw
 * structured states some sites (TikTok) embed for hydration.
 */
export function collectPageState(options: PageStateOptions): PageStatePayload {
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const maxText = options.maxTextChars || 20000;
  const maxLinks = options.maxLinks || 200;
  const maxInteractive = options.maxInteractive || 150;
  const maxHeadings = options.maxHeadings || 30;
  const maxJsonLd = options.maxJsonLd || 10;
  const maxRaw = options.maxRawStateChars || 300000;
  const doc = document;

  const scope = ((): Element => {
    if (options.selector) {
      try {
        const found = doc.querySelector(options.selector);
        if (found) return found;
      } catch {
        /* fall back to the document */
      }
    }
    return doc.body || doc.documentElement;
  })();

  const rawText = (scope as HTMLElement).innerText || scope.textContent || "";
  const text = clean(rawText).slice(0, maxText);

  const meta: Record<string, string> = {};
  const metas = doc.querySelectorAll("meta");
  for (let i = 0; i < metas.length && Object.keys(meta).length < 80; i++) {
    const tag = metas[i];
    const key = tag.getAttribute("property") || tag.getAttribute("name") || tag.getAttribute("itemprop");
    const content = tag.getAttribute("content");
    if (key && content) {
      const normalised = key.toLowerCase();
      if (!(normalised in meta)) meta[normalised] = content.slice(0, 2000);
    }
  }

  const links: PageLink[] = [];
  const anchors = scope.querySelectorAll("a[href]");
  for (let i = 0; i < anchors.length && links.length < maxLinks; i++) {
    const anchor = anchors[i] as HTMLAnchorElement;
    let href = "";
    try {
      href = new URL(anchor.getAttribute("href") || "", location.href).toString();
    } catch {
      continue;
    }
    const entry: PageLink = { text: clean(anchor.innerText || anchor.textContent).slice(0, 200), href };
    const title = anchor.getAttribute("title");
    if (title) entry.title = title.slice(0, 300);
    const rel = anchor.getAttribute("rel");
    if (rel) entry.rel = rel.slice(0, 100);
    links.push(entry);
  }

  const headings: string[] = [];
  const headingNodes = scope.querySelectorAll("h1,h2,h3,h4");
  for (let i = 0; i < headingNodes.length && headings.length < maxHeadings; i++) {
    const value = clean(headingNodes[i].textContent);
    if (value) headings.push(value.slice(0, 300));
  }

  const interactive: InteractiveElement[] = [];
  const nodes = scope.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[tabindex]');
  for (let i = 0; i < nodes.length && interactive.length < maxInteractive; i++) {
    const element = nodes[i] as HTMLElement;
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const name = clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("title"));
    const placeholder = element.getAttribute("placeholder");
    const href = element.getAttribute("href");
    const type = element.getAttribute("type");
    const input = element as HTMLInputElement;
    const entry: InteractiveElement = {
      ref: `e${interactive.length + 1}`,
      tag,
      role,
      type,
      name: name.slice(0, 200),
      text: clean(element.innerText || element.textContent).slice(0, 200),
      placeholder: placeholder ? placeholder.slice(0, 200) : null,
      href: href ? href.slice(0, 2000) : null,
      disabled: Boolean((element as HTMLButtonElement).disabled),
      checked: input && (tag === "input" || tag === "textarea" || tag === "select") ? (type === "checkbox" || type === "radio" ? Boolean(input.checked) : null) : null,
      selector: element.id ? `#${element.id}` : `[data-demo-ref="e${interactive.length + 1}"]`,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    };
    element.setAttribute("data-demo-ref", `e${interactive.length + 1}`);
    interactive.push(entry);
  }

  const jsonLd: string[] = [];
  const ldNodes = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < ldNodes.length && jsonLd.length < maxJsonLd; i++) {
    const value = (ldNodes[i].textContent || "").trim();
    if (value) jsonLd.push(value.slice(0, 100000));
  }

  const rawUniversal = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const rawSigi = doc.getElementById("SIGI_STATE") || doc.getElementById("sigi-persisted-data");
  const rawStates = {
    universal: rawUniversal && rawUniversal.textContent ? rawUniversal.textContent.slice(0, maxRaw) : null,
    sigi: rawSigi && rawSigi.textContent ? rawSigi.textContent.slice(0, maxRaw) : null,
  };

  // NOTE: this block duplicates collectChallengeSignals() on purpose. Functions
  // in this file are serialised with Function.prototype.toString(), so they may
  // not reference anything from the module scope.
  const signals = ((): ChallengeSignalsPayload => {
    const hasAny = (selectors: string[]): boolean => {
      for (const selector of selectors) {
        try {
          if (doc.querySelector(selector)) return true;
        } catch {
          /* invalid selector for this document */
        }
      }
      return false;
    };
    const captchaSelectors = [
      ".g-recaptcha",
      ".h-captcha",
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[src*='turnstile']",
      "iframe[src*='arkoselabs']",
      "iframe[src*='captcha-delivery']",
      "[class*='captcha']",
      "[id*='captcha']",
    ];
    const consentSelectors = [
      "#onetrust-banner-sdk",
      "#CybotCookiebotDialog",
      "#didomi-popup",
      "#sp-message-container",
      "[class*='cookie-banner']",
      "[class*='consent']",
      "[id*='consent']",
      "[aria-label*='cookie']",
    ];
    const hosts: string[] = [];
    const frames = doc.querySelectorAll("iframe");
    for (let i = 0; i < frames.length && hosts.length < 20; i++) {
      const src = frames[i].getAttribute("src");
      if (!src) continue;
      try {
        const host = new URL(src, location.href).hostname;
        if (host && hosts.indexOf(host) === -1) hosts.push(host);
      } catch {
        /* ignore unparsable src */
      }
    }
    return {
      title: clean(doc.title),
      text: String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").slice(0, 20000),
      html: "",
      status: null,
      readyState: doc.readyState,
      hasPasswordField: doc.querySelectorAll('input[type="password"]').length > 0,
      hasCaptchaWidget: hasAny(captchaSelectors),
      hasConsentBanner: hasAny(consentSelectors),
      iframeHosts: hosts,
    };
  })();

  return {
    url: location.href,
    title: doc.title || "",
    lang: doc.documentElement.lang || "",
    readyState: doc.readyState,
    charset: doc.characterSet || null,
    text,
    textLength: rawText.length,
    html: options.includeHtml ? (scope.outerHTML || "").slice(0, options.maxHtmlChars || 200000) : null,
    meta,
    links,
    headings,
    interactive,
    forms: {
      count: doc.querySelectorAll("form").length,
      passwordFields: doc.querySelectorAll('input[type="password"]').length,
      fileInputs: doc.querySelectorAll('input[type="file"]').length,
    },
    media: {
      videoCount: doc.querySelectorAll("video").length,
      audioCount: doc.querySelectorAll("audio").length,
      imageCount: doc.querySelectorAll("img").length,
      canvasCount: doc.querySelectorAll("canvas").length,
    },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      viewportWidth: Math.round(window.innerWidth),
      viewportHeight: Math.round(window.innerHeight),
      documentWidth: Math.round(doc.documentElement.scrollWidth),
      documentHeight: Math.round(doc.documentElement.scrollHeight),
    },
    signals: {
      hasPasswordField: signals.hasPasswordField,
      hasCaptchaWidget: signals.hasCaptchaWidget,
      hasConsentBanner: signals.hasConsentBanner,
      iframeHosts: signals.iframeHosts,
    },
    jsonLd,
    rawStates,
    selector: options.selector ?? null,
    selectorMatched: options.selector ? scope !== doc.body && scope !== doc.documentElement : true,
  };
}

/**
 * Media inspection: <video>/<audio> elements, images, OpenGraph/Twitter cards,
 * JSON-LD and the raw hydration payloads TikTok embeds.
 *
 * Nothing is downloaded here: DEMO only reports what the page already exposes
 * to the browser.
 */
export function collectMediaInfo(options: MediaOptions): MediaPayload {
  const maxMedia = options.maxMediaElements || 20;
  const maxImages = options.maxImages || 20;
  const maxRaw = options.maxRawStateChars || 300000;
  const doc = document;
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();

  const describe = (element: HTMLMediaElement, index: number, tag: "video" | "audio"): MediaElementInfo => {
    const rect = element.getBoundingClientRect();
    const sources: string[] = [];
    const sourceNodes = element.querySelectorAll("source");
    for (let i = 0; i < sourceNodes.length && sources.length < 10; i++) {
      const src = sourceNodes[i].getAttribute("src");
      if (src) {
        try {
          sources.push(new URL(src, location.href).toString());
        } catch {
          sources.push(src);
        }
      }
    }
    const bufferedSeconds = ((): number | null => {
      try {
        const buffered = element.buffered;
        if (!buffered || buffered.length === 0) return null;
        return Number(buffered.end(buffered.length - 1).toFixed(3));
      } catch {
        return null;
      }
    })();
    const mediaError = element.error;
    const video = element as HTMLVideoElement;
    return {
      index,
      tag,
      src: element.getAttribute("src") || null,
      currentSrc: element.currentSrc || null,
      sources,
      poster: element.getAttribute("poster") || null,
      durationSeconds: Number.isFinite(element.duration) ? Number(element.duration.toFixed(3)) : null,
      currentTime: Number.isFinite(element.currentTime) ? Number(element.currentTime.toFixed(3)) : null,
      readyState: element.readyState,
      networkState: element.networkState,
      paused: element.paused,
      muted: element.muted,
      loop: element.loop,
      autoplay: element.autoplay,
      controls: element.controls,
      crossOrigin: element.crossOrigin,
      preload: element.getAttribute("preload"),
      attrWidth: element.getAttribute("width") ? Number(element.getAttribute("width")) : null,
      attrHeight: element.getAttribute("height") ? Number(element.getAttribute("height")) : null,
      intrinsicWidth: tag === "video" ? video.videoWidth || null : null,
      intrinsicHeight: tag === "video" ? video.videoHeight || null : null,
      bufferedSeconds,
      textTracks: element.textTracks ? element.textTracks.length : 0,
      protectedMedia: Boolean((element as unknown as { mediaKeys?: unknown }).mediaKeys),
      errorCode: mediaError ? mediaError.code : null,
      errorMessage: mediaError ? mediaError.message || null : null,
      playsInline: element.hasAttribute("playsinline"),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    };
  };

  const scope: Element | Document = ((): Element | Document => {
    if (options.selector) {
      try {
        const found = doc.querySelector(options.selector);
        if (found) return found;
      } catch {
        /* ignore */
      }
    }
    return doc;
  })();

  const videos: MediaElementInfo[] = [];
  const videoNodes = scope.querySelectorAll("video");
  for (let i = 0; i < videoNodes.length && videos.length < maxMedia; i++) {
    videos.push(describe(videoNodes[i] as HTMLVideoElement, videos.length, "video"));
  }

  const audios: MediaElementInfo[] = [];
  const audioNodes = scope.querySelectorAll("audio");
  for (let i = 0; i < audioNodes.length && audios.length < maxMedia; i++) {
    audios.push(describe(audioNodes[i] as HTMLAudioElement, audios.length, "audio"));
  }

  const images: ImageCandidate[] = [];
  const imageNodes = scope.querySelectorAll("img");
  for (let i = 0; i < imageNodes.length && images.length < maxImages; i++) {
    const image = imageNodes[i] as HTMLImageElement;
    let src = "";
    try {
      src = new URL(image.getAttribute("src") || image.currentSrc || "", location.href).toString();
    } catch {
      src = image.getAttribute("src") || "";
    }
    if (!src) continue;
    images.push({
      src,
      alt: image.getAttribute("alt"),
      attrWidth: image.getAttribute("width") ? Number(image.getAttribute("width")) : null,
      attrHeight: image.getAttribute("height") ? Number(image.getAttribute("height")) : null,
      naturalWidth: image.naturalWidth || null,
      naturalHeight: image.naturalHeight || null,
    });
  }

  const meta: Record<string, string> = {};
  const metas = doc.querySelectorAll("meta");
  for (let i = 0; i < metas.length && Object.keys(meta).length < 80; i++) {
    const tag = metas[i];
    const key = tag.getAttribute("property") || tag.getAttribute("name") || tag.getAttribute("itemprop");
    const content = tag.getAttribute("content");
    if (key && content) {
      const normalised = key.toLowerCase();
      if (!(normalised in meta)) meta[normalised] = content.slice(0, 2000);
    }
  }

  const jsonLd: string[] = [];
  const ldNodes = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < ldNodes.length && jsonLd.length < 10; i++) {
    const value = (ldNodes[i].textContent || "").trim();
    if (value) jsonLd.push(value.slice(0, 100000));
  }

  const rawUniversal = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const rawSigi = doc.getElementById("SIGI_STATE") || doc.getElementById("sigi-persisted-data");

  return {
    url: location.href,
    title: clean(doc.title),
    videos,
    audios,
    images,
    meta,
    jsonLd,
    rawStates: {
      universal: rawUniversal && rawUniversal.textContent ? rawUniversal.textContent.slice(0, maxRaw) : null,
      sigi: rawSigi && rawSigi.textContent ? rawSigi.textContent.slice(0, maxRaw) : null,
    },
    hasVideoElement: videos.length > 0,
    downloadedMedia: false,
  };
}

/**
 * Tag interactive elements with `data-demo-ref` so `browser_click` can address
 * them as `ref:e12`.
 */
export function annotateInteractive(options: InteractiveOptions): InteractiveElement[] {
  const max = options.maxElements || 150;
  const clean = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();
  const doc = document;
  if (options.reset) {
    const existing = doc.querySelectorAll("[data-demo-ref]");
    for (let i = 0; i < existing.length; i++) existing[i].removeAttribute("data-demo-ref");
  }
  const results: InteractiveElement[] = [];
  const nodes = doc.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="tab"],[contenteditable="true"]');
  for (let i = 0; i < nodes.length && results.length < max; i++) {
    const element = nodes[i] as HTMLElement;
    if (element.hasAttribute("data-demo-ref")) continue;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") continue;
    const style = doc.defaultView ? doc.defaultView.getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) continue;
    const rect = element.getBoundingClientRect();
    const ref = `e${results.length + 1}`;
    element.setAttribute("data-demo-ref", ref);
    const tag = element.tagName.toLowerCase();
    const input = element as HTMLInputElement;
    const type = element.getAttribute("type");
    results.push({
      ref,
      tag,
      role: element.getAttribute("role"),
      type,
      name: clean(element.getAttribute("aria-label") || element.getAttribute("name") || element.getAttribute("title")).slice(0, 200),
      text: clean(element.innerText || element.textContent).slice(0, 200),
      placeholder: element.getAttribute("placeholder"),
      href: element.getAttribute("href"),
      disabled: Boolean((element as HTMLButtonElement).disabled),
      checked: type === "checkbox" || type === "radio" ? Boolean(input.checked) : null,
      selector: element.id ? `#${element.id}` : `[data-demo-ref="${ref}"]`,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    });
  }
  return results;
}

/** Mute/pause a video so frames can be sampled deterministically. */
export function prepareVideoForSampling(options: VideoPrepareOptions): VideoPrepareResult {
  const doc = document;
  const scope: Element | Document = ((): Element | Document => {
    if (options.selector) {
      try {
        const found = doc.querySelector(options.selector);
        if (found) return found;
      } catch {
        /* ignore */
      }
    }
    return doc;
  })();
  const videos = scope.querySelectorAll("video");
  const video = videos[options.index] as HTMLVideoElement | undefined;
  if (!video) {
    return { found: false, durationSeconds: null, intrinsicWidth: null, intrinsicHeight: null, readyState: 0, protectedMedia: false, errorMessage: "No <video> element at the requested index.", rect: null };
  }
  try {
    video.muted = true;
    video.volume = 0;
    video.pause();
    const rect = video.getBoundingClientRect();
    return {
      found: true,
      durationSeconds: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null,
      intrinsicWidth: video.videoWidth || null,
      intrinsicHeight: video.videoHeight || null,
      readyState: video.readyState,
      protectedMedia: Boolean((video as unknown as { mediaKeys?: unknown }).mediaKeys),
      errorMessage: video.error ? video.error.message || "media error" : null,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  } catch (error) {
    return {
      found: true,
      durationSeconds: null,
      intrinsicWidth: null,
      intrinsicHeight: null,
      readyState: 0,
      protectedMedia: false,
      errorMessage: String(error),
      rect: null,
    };
  }
}

/**
 * Seek a video to a timestamp and resolve once the browser reports `seeked`.
 * Frames are then captured with a clipped page screenshot (no media download).
 */
export function seekVideo(options: SeekOptions): Promise<SeekResult> {
  return new Promise((resolve) => {
    const doc = document;
    const scope: Element | Document = ((): Element | Document => {
      if (options.selector) {
        try {
          const found = doc.querySelector(options.selector);
          if (found) return found;
        } catch {
          /* ignore */
        }
      }
      return doc;
    })();
    const video = scope.querySelectorAll("video")[options.index] as HTMLVideoElement | undefined;
    if (!video) {
      resolve({ ok: false, currentTime: null, readyState: 0, error: "No <video> element at the requested index." });
      return;
    }
    let settled = false;
    const finish = (result: SeekResult): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      resolve(result);
    };
    const onSeeked = (): void => {
      finish({ ok: true, currentTime: Number(video.currentTime.toFixed(3)), readyState: video.readyState, error: null });
    };
    video.addEventListener("seeked", onSeeked);
    const timeout = setTimeout(() => {
      finish({ ok: false, currentTime: Number(video.currentTime.toFixed(3)), readyState: video.readyState, error: "Timed out waiting for the video to seek." });
    }, options.timeoutMs || 5000);
    const original = timeout;
    void original;
    try {
      video.currentTime = options.time;
    } catch (error) {
      finish({ ok: false, currentTime: null, readyState: video.readyState, error: String(error) });
    }
  });
}

/** Wait for the document to reach `complete` (bounded). */
export function waitForDocumentComplete(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (document.readyState === "complete") {
      resolve("complete");
      return;
    }
    let settled = false;
    const done = (state: string): void => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    document.addEventListener("readystatechange", () => {
      if (document.readyState === "complete") done("complete");
    });
    setTimeout(() => done(document.readyState), timeoutMs || 5000);
  });
}
