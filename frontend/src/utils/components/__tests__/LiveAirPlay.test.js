import { describe, it, expect, vi, beforeEach } from 'vitest';
import { airPlayOutputProfile, AIRPLAY_PROFILE_NAME, buildNativeHlsUrl, supportsNativeAirPlay, createNativeLivePlayer } from '../LiveAirPlay';

const origin = 'http://192.168.50.84:9191';
const sessionUrl = `${origin}/proxy/hls/test-session/index.m3u8`;
const playlist = '#EXTM3U\n#EXTINF:4,\n1.ts\n';

function setup(response = {}) {
  const video = document.createElement('video');
  video.load = vi.fn();
  video.play = vi.fn().mockResolvedValue();
  video.pause = vi.fn();
  const fetcher = vi.fn().mockResolvedValue({
    ok: true, url: sessionUrl, text: async () => playlist, ...response,
  });
  const callbacks = { onReady: vi.fn(), onPlaying: vi.fn(), onError: vi.fn() };
  const player = createNativeLivePlayer({
    video, url: `${origin}/proxy/ts/stream/channel?output_format=hls&skip_redirect=true`,
    getToken: vi.fn().mockResolvedValue('current-access-token'), fetcher, ...callbacks,
  });
  return { video, fetcher, player, ...callbacks };
}

describe('Live AirPlay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries a transient server setup error before using the ready HLS session', async () => {
    const { player, fetcher, video, onError } = setup();
    fetcher.mockResolvedValueOnce({ ok: false, status: 500 });
    vi.useFakeTimers();
    try {
      const starting = player.start();
      await vi.advanceTimersByTimeAsync(1000);
      await starting;
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(video.src).toBe(sessionUrl + '?native=1');
      expect(onError).not.toHaveBeenCalled();
      player.destroy();
    } finally { vi.useRealTimers(); }
  });

  it('does not retry rejected credentials', async () => {
    const { player, fetcher, onError } = setup({ ok: false, status: 401 });
    await player.start();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('limits server retries and stops retrying after cancellation', async () => {
    const { player, fetcher, onError } = setup({ ok: false, status: 503 });
    vi.useFakeTimers();
    try {
      const starting = player.start();
      await vi.advanceTimersByTimeAsync(2000);
      await starting;
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledOnce();
      const another = setup({ ok: false, status: 503 });
      const canceled = another.player.start();
      await vi.advanceTimersByTimeAsync(0);
      another.player.destroy();
      await vi.advanceTimersByTimeAsync(1000);
      await canceled;
      expect(another.fetcher).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('plays and releases an anonymous session without requesting or sending login credentials', async () => {
    const video = document.createElement('video');
    video.play = vi.fn().mockResolvedValue();
    const getToken = vi.fn();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, url: sessionUrl, text: async () => playlist });
    const player = createNativeLivePlayer({
      video, url: origin + '/proxy/ts/stream/channel?output_format=hls', anonymous: true, getToken, fetcher,
      onReady: vi.fn(), onPlaying: vi.fn(), onError: vi.fn(),
    });
    await player.start();
    expect(getToken).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
    expect(video.src).toBe(sessionUrl + '?native=1');
    player.destroy();
    expect(fetcher.mock.calls[1]).toEqual([
      origin + '/api/watch/sessions/test-session/',
      { method: 'DELETE', headers: undefined, keepalive: true },
    ]);
  });

  it('requests HLS while preserving the selected output profile', () => {
    const url = new URL(buildNativeHlsUrl('/proxy/ts/stream/channel?output_format=mpegts&output_profile=5', origin));
    expect(url.searchParams.get('output_format')).toBe('hls');
    expect(url.searchParams.get('skip_redirect')).toBe('true');
    expect(url.searchParams.get('output_profile')).toBe('5');
  });

  it('adds the compatibility profile while respecting an explicit user choice', () => {
    expect(new URL(buildNativeHlsUrl('/proxy/ts/stream/channel', origin, 3)).searchParams.get('output_profile')).toBe('3');
    expect(new URL(buildNativeHlsUrl('/proxy/ts/stream/channel?output_profile=5', origin, 3)).searchParams.get('output_profile')).toBe('5');
    const outputs = [{ id: 3, name: AIRPLAY_PROFILE_NAME, is_active: true }];
    expect(airPlayOutputProfile({}, outputs)).toBe(3);
    expect(airPlayOutputProfile({ streamProfileId: 10 }, outputs, [{ id: 10, name: 'IPTV Dynamic test',
      parameters: '-c:v libx264 -preset ultrafast -tune zerolatency -c:a aac' }])).toBeUndefined();
  });

  it('rejects external origins and non-preview paths before sending authentication', () => {
    expect(() => buildNativeHlsUrl('http://elsewhere.invalid/proxy/ts/stream/channel', origin)).toThrow();
    expect(() => buildNativeHlsUrl('/output/m3u', origin)).toThrow();
  });

  it('requires both native HLS and an AirPlay route picker', () => {
    const video = { canPlayType: () => 'maybe', webkitShowPlaybackTargetPicker: () => {} };
    expect(supportsNativeAirPlay(video)).toBe(true);
    expect(supportsNativeAirPlay({ ...video, canPlayType: () => '' })).toBe(false);
    expect(supportsNativeAirPlay({ canPlayType: () => 'probably' })).toBe(false);
  });

  it('passes only an opaque session URL to the media element and stops its own session', async () => {
    const { video, fetcher, player, onReady } = setup();
    await player.start();
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer current-access-token');
    expect(video.src).toBe(sessionUrl + '?native=1');
    expect(video.src).not.toContain('current-access-token');
    expect(onReady).toHaveBeenCalledOnce();
    expect(video.play).toHaveBeenCalledOnce();
    player.destroy();
    player.destroy();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual([
      `${origin}/api/proxy/hls/sessions/test-session/`,
      { method: 'DELETE', headers: { Authorization: 'Bearer current-access-token' }, keepalive: true },
    ]);
  });

  it('ignores a late bootstrap after channel switching and releases that session', async () => {
    const { video, fetcher, player, onReady, onError } = setup();
    let resolve;
    fetcher.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const starting = player.start();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    player.destroy();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    resolve({ ok: true, url: sessionUrl, text: async () => playlist });
    await starting;
    expect(video.getAttribute('src')).toBeNull();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
  });

  it('holds the previous TV session until the replacement is ready', async () => {
    const { player, fetcher } = setup();
    await player.start();
    const release = player.destroy({ keepSession: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(release).toBeTypeOf('function');
    release();
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
  });

  it('waits for a safe live window and polls without forwarding browser credentials', async () => {
    const { player, fetcher, video } = setup({ text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n1.ts\n' });
    fetcher.mockResolvedValueOnce({ ok: true, url: sessionUrl,
      text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n1.ts\n' });
    fetcher.mockResolvedValueOnce({ ok: true, text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:3,\n1.ts\n' });
    vi.useFakeTimers();
    try {
      const starting = player.start();
      await vi.advanceTimersByTimeAsync(1000);
      await starting;
      expect(fetcher.mock.calls[1][1]).toEqual({ cache: 'no-store', signal: expect.any(AbortSignal) });
      expect(video.src).toBe(sessionUrl + '?native=1');
      player.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an empty playlist and releases its session', async () => {
    const { player, fetcher, video, onError } = setup({ text: async () => '#EXTM3U\n' });
    await player.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(video.getAttribute('src')).toBeNull();
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
    player.destroy();
  });

  it('does not send a session URL from an unexpected origin to the TV', async () => {
    const { player, video, onError } = setup({ url: 'http://elsewhere.invalid/proxy/hls/test-session/index.m3u8' });
    await player.start();
    expect(onError).toHaveBeenCalledOnce();
    expect(video.getAttribute('src')).toBeNull();
    player.destroy();
  });

  it('offers a play or AirPlay tap when Safari blocks asynchronous autoplay', async () => {
    const { player, video, onError, fetcher } = setup();
    video.play.mockRejectedValue(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
    await player.start();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('AirPlay'));
    expect(video.src).toBe(sessionUrl + '?native=1');
    expect(fetcher).toHaveBeenCalledOnce();
    player.destroy();
  });
});
