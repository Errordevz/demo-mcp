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

/**
 * Controlled CAPTCHA simulation for the human-handoff end-to-end tests.
 *
 * The widget is deliberately realistic (`.g-recaptcha` + sitekey) so the
 * challenge detector classifies the page as `captcha`. The
 * `SOLVE_CAPTCHA_SIMULATION` script wires the page's "I am human" control so
 * that pressing it removes the challenge in place — exactly what a human
 * completing the challenge inside a Live View looks like to the detector. In
 * the tests the *human* (the test harness) presses it; Demo never touches it.
 */
export const CAPTCHA_SIMULATION_PAGE = `<!doctype html><html><head><title>Security check · Example App</title></head>
<body><div id="challenge-panel"><h1>Quick security check</h1>
<div class="g-recaptcha" data-sitekey="6LeSIMULATION000000"></div>
<p id="challenge-status">Press the button to continue</p>
<button id="human-verify" type="button">I am human</button></div></body></html>`;

/** Wire the simulated challenge so a click on the control clears it in place. */
export const SOLVE_CAPTCHA_SIMULATION = (window: any): void => {
  const doc = window.document;
  const button = doc.getElementById("human-verify");
  if (!button || button.dataset.wired === "true") return;
  button.dataset.wired = "true";
  button.addEventListener("click", () => {
    doc.querySelector(".g-recaptcha")?.remove();
    const status = doc.getElementById("challenge-status");
    if (status) status.textContent = "Thanks — the check is complete.";
    const panel = doc.getElementById("challenge-panel");
    if (panel) panel.setAttribute("data-solved", "true");
  });
};

/** The page a site serves after the challenge has been passed. */
export const AFTER_CHALLENGE_PAGE = `<!doctype html><html><head><title>Dashboard · Example App</title></head>
<body><h1>Welcome back</h1><p>Your report is ready to download.</p></body></html>`;

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

/* -------------------------------------------------------------------------- */
/* Instagram / YouTube / X / Reddit fixtures                                   */
/* -------------------------------------------------------------------------- */

/** Instagram reel page with shortcode-media JSON (public, with video). */
export function instagramReelPage(options: { imagePost?: boolean; privateAccount?: boolean; loginWall?: boolean } = {}): string {
  if (options.loginWall) {
    return `<!doctype html><html><head><title>Log in • Instagram</title></head>
<body><main><h1>Log in to Instagram</h1><p>Log in to see photos and videos from friends and discover other accounts you'll love.</p>
<form><input name="username"><input type="password" name="password"></form></main></body></html>`;
  }
  const shortcode = "C0d3R33lXyZ";
  const media = options.privateAccount
    ? { __typename: "GraphVideo", shortcode_media: null, owner: { username: "private.creator", is_private: true } }
    : options.imagePost
      ? { __typename: "GraphImage", owner: { username: "photo.creator", is_private: false }, taken_at: 1_700_000_000 }
      : {
          __typename: "GraphVideo",
          video_url: "https://scontent-lax3-2.cdninstagram.com/o1/v/t2/f2/m69/AQO1234567890.mp4?oe=9999999999&_nc_cat=1",
          playable_url: "https://scontent-lax3-1.cdninstagram.com/o1/v/t2/f2/m69/AQO0987654321.mp4?oe=9999999999&_nc_cat=2",
          video_duration: 12.5,
          dimensions: { width: 720, height: 1280 },
          owner: { username: "reel.creator", is_private: false },
          taken_at: 1_700_000_000,
          edge_media_to_caption: { edges: [{ node: { text: "Sunset timelapse over the bay #timelapse" } }] },
        };
  const videoMeta = options.privateAccount || options.imagePost ? "" : `<meta property="og:video" content="https://scontent-lax3-2.cdninstagram.com/o1/v/t2/f2/m69/AQO1234567890.mp4?oe=9999999999">`;
  return `<!doctype html><html lang="en"><head>
<title>reel.creator on Instagram: "Sunset timelapse"</title>
<meta property="og:title" content="reel.creator on Instagram">
<meta property="og:description" content="Sunset timelapse over the bay #timelapse">
<meta property="og:image" content="https://scontent-lax3-2.cdninstagram.com/o1/v/t2/f2/m69/thumb.jpg?oe=9999999999">
${videoMeta}
</head><body>
<main><article><video poster="https://scontent-lax3-2.cdninstagram.com/thumb.jpg"></video></article></main>
<script type="text/javascript">window.__additionalDataLoaded('/reel/${shortcode}/', ${JSON.stringify({ shortcode_media: media })});</script>
</body></html>`;
}

/** YouTube watch page with a ytInitialPlayerResponse payload. */
export function youtubeWatchPage(
  options: { playability?: "OK" | "PRIVATE" | "LOGIN_REQUIRED" | "UNPLAYABLE"; cipheredOnly?: boolean; noStreaming?: boolean } = {},
): string {
  const videoId = "dQw4w9WgXcQ";
  const playability = options.playability ?? "OK";
  const reason = playability === "PRIVATE" ? "This video is private." : playability === "LOGIN_REQUIRED" ? "Sign in to confirm your age." : playability === "UNPLAYABLE" ? "This video is no longer available." : undefined;
  const player: Record<string, unknown> = {
    playabilityStatus: { status: playability, ...(reason ? { reason } : {}) },
    videoDetails: {
      videoId,
      title: playability === "OK" ? "Never Gonna Give You Up (Official Video)" : "Private video",
      author: "Rick Astley",
      lengthSeconds: "212",
      shortDescription: "The official video for Never Gonna Give You Up.",
      viewCount: "1500000000",
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${videoId}/default.jpg` }, { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }] },
    },
  };
  if (!options.noStreaming && playability === "OK") {
    player.streamingData = {
      formats: options.cipheredOnly
        ? [{ itag: 18, signatureCipher: "url=https%3A%2F%2Fexample.com%2Fvideoplayback&s=ABCDEF123456", mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', width: 640, height: 360, bitrate: 500_000 }]
        : [
            { itag: 18, url: "https://rr1---sn-example.googlevideo.com/videoplayback?expire=9999999999&ip=1.2.3.4", mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', width: 640, height: 360, bitrate: 500_000 },
            { itag: 22, signatureCipher: "url=https%3A%2F%2Fexample.com%2Fvideoplayback&s=ABCDEF123456", mimeType: 'video/mp4; codecs="avc1.64001F, mp4a.40.2"', width: 1280, height: 720, bitrate: 2_000_000 },
          ],
      adaptiveFormats: [{ itag: 140, url: "https://rr1---sn-example.googlevideo.com/videoplayback?expire=9999999999&mime=audio", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128_000 }],
      hlsManifestUrl: "https://manifest.googlevideo.com/api/manifest/hls_playlist/id/dQw4w9WgXcQ",
      dashManifestUrl: "https://manifest.googlevideo.com/api/manifest/dash/id/dQw4w9WgXcQ",
    };
  }
  return `<!doctype html><html lang="en"><head>
<title>${playability === "OK" ? "Never Gonna Give You Up (Official Video) - YouTube" : "Private video - YouTube"}</title>
<meta property="og:title" content="Never Gonna Give You Up (Official Video)">
<meta property="og:image" content="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Never Gonna Give You Up","uploadDate":"2009-10-25"}</script>
</head><body>
<div id="player"></div>
<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>
</body></html>`;
}

/** X post page with a __NEXT_DATA__ payload carrying video_info variants. */
export function xPostPage(options: { photoOnly?: boolean; protectedAccount?: boolean } = {}): string {
  const statusId = "1700000000000000001";
  const media = options.photoOnly
    ? [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/photo.jpg" }]
    : [
        {
          type: "video",
          media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg",
          video_info: {
            duration_millis: 15_000,
            variants: [
              { content_type: "video/mp4", bitrate: 832_000, url: "https://video.twimg.com/ext_tw_video/abc/pu/vid/320x180/clip.mp4" },
              { content_type: "video/mp4", bitrate: 2_176_000, url: "https://video.twimg.com/ext_tw_video/abc/pu/vid/1280x720/clip.mp4" },
              { content_type: "application/x-mpegURL", url: "https://video.twimg.com/ext_tw_video/abc/pu/pl/playlist.m3u8" },
            ],
          },
        },
      ];
  const nextData = {
    props: {
      pageProps: {
        tweetResult: {
          result: {
            rest_id: statusId,
            legacy: {
              full_text: "Launch day has arrived — watch the full cut here.",
              created_at: "Tue Nov 14 12:00:00 +0000 2023",
              user_id_str: "44196397",
              extended_entities: { media },
            },
            core: { user_results: { result: { legacy: { screen_name: "launch_creator" } } } },
          },
        },
      },
    },
  };
  const protectedBanner = options.protectedAccount ? `<div class="protected"><h1>These posts are protected</h1><p>Only approved followers can see @locked_creator's posts.</p></div>` : "";
  return `<!doctype html><html lang="en"><head>
<title>launch_creator on X: "Launch day has arrived"</title>
<meta property="og:description" content="Launch day has arrived — watch the full cut here.">
<meta property="og:image" content="https://pbs.twimg.com/ext_tw_video_thumb/poster.jpg">
</head><body>
<main>${protectedBanner}<article><p>Launch day has arrived — watch the full cut here.</p></article></main>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
</body></html>`;
}

/** Reddit post page with shreddit-player attributes + reddit_video JSON. */
export function redditPostPage(options: { imagePost?: boolean; privateCommunity?: boolean } = {}): string {
  const postId = "abc123x";
  if (options.privateCommunity) {
    return `<!doctype html><html><head><title>r/locked: This community is private</title></head>
<body><main><h1>This community is private</h1><p>You must be invited to visit this community.</p></main></body></html>`;
  }
  const player = options.imagePost
    ? `<img src="https://preview.redd.it/photo.jpg" alt="post image">`
    : `<shreddit-player fallback-url="https://v.redd.it/${postId}/DASH_720.mp4" hls-url="https://v.redd.it/${postId}/HLSPlaylist.m3u8" dash-url="https://v.redd.it/${postId}/DASHPlaylist.mpd" poster="https://preview.redd.it/poster.jpg"></shreddit-player>`;
  const postJson = options.imagePost
    ? { id: `t3_${postId}`, title: "Look at this view", author: "poster", is_video: false, post_hint: "image" }
    : {
        id: `t3_${postId}`,
        title: "My first successful landing",
        author: "rocketeer",
        is_video: true,
        media: { reddit_video: { fallback_url: `https://v.redd.it/${postId}/DASH_720.mp4`, hls_url: `https://v.redd.it/${postId}/HLSPlaylist.m3u8`, dash_url: `https://v.redd.it/${postId}/DASHPlaylist.mpd`, duration: 15, width: 720, height: 1280 } },
      };
  return `<!doctype html><html lang="en"><head>
<title>${options.imagePost ? "Look at this view" : "My first successful landing"} : r/space</title>
<meta property="og:title" content="${options.imagePost ? "Look at this view" : "My first successful landing"}">
<meta property="og:image" content="https://preview.redd.it/poster.jpg">
</head><body>
<main>${player}</main>
<script type="application/json" id="post-data">${JSON.stringify({ post: postJson })}</script>
</body></html>`;
}
