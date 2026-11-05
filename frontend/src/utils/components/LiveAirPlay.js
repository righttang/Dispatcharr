export const supportsNativeAirPlay = (video) => Boolean(
  video && typeof video.webkitShowPlaybackTargetPicker === 'function'
    && video.canPlayType('application/vnd.apple.mpegurl')
);

export const AIRPLAY_PROFILE_NAME = 'IPTV AirPlay compatibility';

export const airPlayOutputProfile = (metadata, outputs = [], sources = []) => {
  const source = sources.find(profile => profile.id === metadata?.streamProfileId);
  if (source?.name.startsWith('IPTV Dynamic ')
    && ['-c:v libx264', '-preset ultrafast', '-tune zerolatency', '-c:a aac']
      .every(flag => source.parameters.includes(flag))) return undefined;
  return outputs.find(profile => profile.name === AIRPLAY_PROFILE_NAME && profile.is_active)?.id;
};

export const buildNativeHlsUrl = (url, origin = window.location.origin, profileId) => {
  const parsed = new URL(url, origin);
  if (parsed.origin !== origin || !/^\/proxy\/ts\/stream\/[^/]+$/.test(parsed.pathname)) {
    throw new Error('Unsupported live preview URL');
  }
  parsed.searchParams.set('output_format', 'hls');
  parsed.searchParams.set('skip_redirect', 'true');
  if (profileId && !parsed.searchParams.has('output_profile')) {
    parsed.searchParams.set('output_profile', String(profileId));
  }
  return parsed.href;
};

const sessionFromUrl = (url, origin) => {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/proxy\/hls\/([\w-]+)\/index\.m3u8$/);
  if (parsed.origin !== origin || !match) throw new Error('Unexpected HLS session URL');
  return { url: parsed.href, token: match[1] };
};

export function createNativeLivePlayer({ video, url, getToken, onReady, onPlaying, onError, fetcher = fetch }) {
  const controller = new AbortController();
  let destroyed = false;
  let session;
  let accessToken;
  let released = false;
  let preparing = true;
  const origin = new URL(url).origin;

  const release = () => {
    if (!session || released) return;
    released = true;
    // This stops only this viewer's session, including a TV using its URL.
    void fetcher(`${origin}/api/proxy/hls/sessions/${session.token}/`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` }, keepalive: true,
    }).catch(() => {});
  };
  const play = () => {
    try {
      return Promise.resolve(video.play());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const playing = () => { if (!destroyed && !preparing) onPlaying(); };
  const failed = () => {
    if (!destroyed && !preparing) {
      onError('这个频道暂时无法播放，请重新选台后再试。');
      release();
    }
  };
  video.addEventListener('playing', playing);
  video.addEventListener('error', failed);

  return {
    nativeLive: true,
    pause: () => video.pause(),
    play,
    async start() {
      try {
        accessToken = await getToken();
        if (destroyed) return;
        if (!accessToken) throw new Error('Login expired');
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HLS bootstrap failed (${response.status})`);
        session = sessionFromUrl(response.url, origin);
        if (destroyed) { release(); return; }
        let playlist = await response.text();
        if (destroyed) { release(); return; }
        if (!playlist.startsWith('#EXTM3U') || !playlist.includes('#EXTINF:')) {
          throw new Error('HLS playlist has no media');
        }
        const deadline = Date.now() + 40000;
        while (!playlist.includes('#EXT-X-ENDLIST')) {
          const target = Number(playlist.match(/^#EXT-X-TARGETDURATION:(\d+)/m)?.[1] || 0);
          const buffered = [...playlist.matchAll(/^#EXTINF:([\d.]+)/gm)]
            .reduce((total, match) => total + Number(match[1]), 0);
          if (!target || buffered >= target * 3) break;
          if (Date.now() >= deadline) throw new Error('Live playlist is not ready');
          // Native players need enough media behind the live edge to start.
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (destroyed) { release(); return; }
          const next = await fetcher(session.url, { cache: 'no-store', signal: controller.signal });
          if (!next.ok) throw new Error('Live session expired while preparing');
          playlist = await next.text();
        }
        // The TV receives this opaque URL; browser login tokens stay off it.
        const mediaUrl = new URL(session.url);
        mediaUrl.searchParams.set('native', '1');
        video.src = mediaUrl.href;
        preparing = false;
        onReady();
        try {
          await play();
        } catch (error) {
          if (!destroyed && error.name !== 'AbortError') {
            onError(error.name === 'NotAllowedError'
              ? '点画面中的播放按钮，或点 AirPlay 在电视上播放。'
              : '播放暂时未能开始，请点播放按钮重试。');
          }
        }
      } catch (error) {
        release();
        if (!destroyed && error.name !== 'AbortError') {
          onError('频道暂时未能加载，请重新选台后再试。');
        }
      }
    },
    destroy({ keepSession = false } = {}) {
      destroyed = true;
      controller.abort();
      video.removeEventListener('playing', playing);
      video.removeEventListener('error', failed);
      if (keepSession && !preparing && session && !released) return release;
      release();
    },
  };
}
