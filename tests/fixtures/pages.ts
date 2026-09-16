/**
 * HTML fixtures that imitate the kinds of pages DEMO has to handle.
 *
 * They are deliberately shaped like the real thing (TikTok's hydration payload,
 * Cloudflare's challenge markup, consent banners) so the detectors and parsers
 * are tested against realistic input instead of toy strings.
 */

export const SIMPLE_PAGE = `<!doctype html><html><head><title>Example Domain</title>
<meta name="description" content="Used for documentation examples."></head>
<body><h1>Example Domain</h1><p>This domain is for use in documentation examples.</p>
<a href="/more">More information</a><button id="go">Go</button></body></html>`;

export const LOGIN_WALL = `<!doctype html><html><head><title>Sign in to continue · Example</title></head>
<body><div class="authwall"><h1>Sign in required</h1>
<form action="/session" method="post"><input name="username" placeholder="Email"><input type="password" name="password"></form>
<p>You must be logged in to view this page.</p></div></body></html>`;

export const CLOUDFLARE_INTERSTITIAL = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="cf-wrapper"><div class="cf-browser-verification cf_chl_opt">
<h1>Please complete the security check to continue</h1>
<div class="g-recaptcha" data-sitekey="6LeXXXX"></div>
<p>Verify you are human. Ray ID: 7c1f0000</p></div></body></html>`;

export const CONSENT_PAGE = `<!doctype html><html><head><title>News</title></head>
<body><div id="onetrust-banner-sdk"><h2>We use cookies</h2>
<button id="onetrust-accept-btn-handler">Accept all cookies</button></div>
<main><h1>Today's headlines</h1><p>Story one.</p></main></body></html>`;

export const ACCESS_DENIED = `<!doctype html><html><head><title>Access denied</title></head>
<body><h1>Error code: 1020</h1><p>Access denied. You do not have permission to view this page.</p></body></html>`;

export const NOT_FOUND = `<!doctype html><html><head><title>Page not found</title></head>
<body><h1>404</h1><p>This page isn't available. The link may be broken.</p></body></html>`;

/** TikTok verification wall served to untrusted browsers. */
export const TIKTOK_VERIFICATION = `<!doctype html><html><head><title>Verify to continue</title>
<meta property="og:title" content="Verify"></head>
<body><div id="tiktok-verify-elem"><div class="captcha-verify-container">
<h2>Security check</h2><div class="tiktok-captcha"></div><p>Please verify you are human to continue</p>
</div></body></html>`;

function universalPayload(overrides: Record<string, unknown> = {}): unknown {
  const item = {
    id: "7300000000000000001",
    desc: "Testing the new browser tool #demo #browser #tiktok",
    createTime: 1_700_000_000,
    author: {
      id: "6800000000000000001",
      uniqueId: "creator.one",
      nickname: "Creator One",
      avatarLarger: "https://p16-sign.tiktokcdn.com/avatar.jpeg",
      verified: true,
    },
    video: {
      duration: 17,
      cover: "https://p16-sign.tiktokcdn.com/cover.jpeg",
      originCover: "https://p16-sign.tiktokcdn.com/origin.jpeg",
      dynamicCover: "https://p16-sign.tiktokcdn.com/dynamic.jpeg",
      playAddr: "https://v16-webapp.tiktokcdn.com/video.mp4?x-expires=1700000000&x-signature=abc",
      downloadAddr: "https://v16-webapp.tiktokcdn.com/video.mp4",
      ratio: "720p",
      width: 720,
      height: 1280,
    },
    music: { id: "7000000000000000001", title: "Original Sound", authorName: "Creator One", playUrl: "https://sf16.tiktokcdn.com/music.mp3" },
    stats: { playCount: 1_250_000, diggCount: 98_000, commentCount: 4_321, shareCount: 2_100, collectCount: 900 },
    challenges: [{ id: "1", title: "demo" }],
    ...overrides,
  };
  return { __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct: item } } } };
}

export function tiktokVideoPage(options: { imagePost?: boolean; withoutMedia?: boolean } = {}): string {
  const payload = universalPayload(
    options.imagePost ? { video: undefined, imagePost: { images: [{ imageURL: { url_list: ["https://p16.tiktokcdn.com/photo1.jpeg"] } }] } } : {},
  );
  if (options.withoutMedia) {
    const item = (payload as any).__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct;
    delete item.video;
  }
  return `<!doctype html><html lang="en"><head>
<title>Creator One on TikTok</title>
<meta property="og:title" content="Testing the new browser tool">
<meta property="og:image" content="https://p16-sign.tiktokcdn.com/cover.jpeg">
<meta property="og:description" content="Testing the new browser tool #demo">
<meta property="og:url" content="https://www.tiktok.com/@creator.one/video/7300000000000000001">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Testing","uploadDate":"2023-11-14"}</script>
</head><body>
<div id="app"><video id="tiktok-video" playsinline poster="https://p16-sign.tiktokcdn.com/cover.jpeg" src="https://v16-webapp.tiktokcdn.com/video.mp4"></video></div>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;
}

export const SIGI_PAYLOAD = JSON.stringify({
  ItemModule: {
    "7300000000000000002": {
      id: "7300000000000000002",
      desc: "Legacy SIGI payload #old",
      createTime: 1_690_000_000,
      author: { id: "6", unique_id: "legacy.creator", nickname: "Legacy" },
      video: { duration: 9, cover: "https://p16.tiktokcdn.com/legacy.jpeg", playAddr: "https://v16.tiktokcdn.com/legacy.mp4" },
      stats: { playCount: 10, diggCount: 2, commentCount: 1, shareCount: 0 },
    },
  },
});

export function tiktokSigiPage(): string {
  return `<!doctype html><html><head><title>Legacy creator</title></head><body>
<script id="SIGI_STATE" type="application/json">${SIGI_PAYLOAD}</script></body></html>`;
}

/**
 * A TikTok page carrying the published `webapp.video-detail.statusCode` verdict.
 *
 * TikTok answers 200 with an HTML shell for deleted/private/region-restricted/
 * CAPTCHA-gated items and encodes the real reason in this field, so a
 * retrieval pipeline must read it rather than trusting the HTTP status.
 */
export function tiktokStatusPage(statusCode: number, statusMsg = "", options: { withItem?: boolean; canonical?: string } = {}): string {
  const detail: Record<string, unknown> = { statusCode, statusMsg };
  if (options.withItem !== false && statusCode === 0) {
    detail.itemInfo = { itemStruct: (universalPayload() as any).__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct };
  }
  const payload = { __DEFAULT_SCOPE__: { "webapp.video-detail": detail } };
  const canonical = options.canonical ?? "https://www.tiktok.com/@creator.one/video/7300000000000000001";
  return `<!doctype html><html lang="en"><head>
<title>TikTok</title>
<meta property="og:url" content="${canonical}">
<meta property="og:title" content="Video unavailable">
</head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;
}

/** A hydration payload with several literal signed stream URLs to rank. */
export function tiktokMultiStreamPage(options: { expired?: boolean } = {}): string {
  const signature = options.expired ? "x-expires=1700000000&x-signature=old" : "x-expires=9999999999&x-signature=new";
  const item = {
    id: "7300000000000000009",
    desc: "Multiple bitrates #streams",
    createTime: 1_700_000_000,
    author: { id: "9", uniqueId: "multi.creator", nickname: "Multi" },
    video: {
      duration: 12,
      width: 720,
      height: 1280,
      playAddr: `https://v16-webapp.tiktokcdn.com/stream-720p.mp4?${signature}`,
      downloadAddr: `https://v16-webapp.tiktokcdn.com/stream-download.mp4?${signature}`,
      bitRate: [
        { gearName: "lower_720_1", qualityType: "HD", bitRate: 900_000, playAddr: `https://v16-webapp.tiktokcdn.com/stream-720p.mp4?${signature}`, format: "mp4" },
        { gearName: "lowest_540_1", qualityType: "SD", bitRate: 400_000, playAddr: `https://v16-webapp.tiktokcdn.com/stream-540p.mp4?${signature}`, format: "mp4" },
      ],
    },
    stats: { playCount: 5, diggCount: 1, commentCount: 0, shareCount: 0 },
  };
  const payload = { __DEFAULT_SCOPE__: { "webapp.video-detail": { statusCode: 0, itemInfo: { itemStruct: item } } } };
  return `<!doctype html><html lang="en"><head>
<title>Multi on TikTok</title>
<meta property="og:url" content="https://www.tiktok.com/@multi.creator/video/7300000000000000009">
<meta property="og:description" content="Multiple bitrates #streams">
<meta name="video:duration" content="12">
</head><body>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(payload)}</script>
</body></html>`;
}
