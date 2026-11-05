import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import MobileChannels from '../MobileChannels';

const { showVideo, getChannels } = vi.hoisted(() => ({ showVideo: vi.fn(), getChannels: vi.fn() }));
vi.mock('../../api', () => ({ default: { getChannelsForParams: getChannels } }));
vi.mock('../../store/channels', () => ({ default: (select) => select({
  channelGroups: { 1: { name: '新闻' } }, profiles: {}, selectedProfileId: '0',
}) }));
vi.mock('../../store/useVideoStore', () => ({ default: (select) => select({
  showVideo, metadata: null, isVisible: false, contentType: 'live',
}) }));
vi.mock('../../utils/components/FloatingVideoUtils', () => ({ buildLiveStreamUrl: (url) => url }));

describe('Mobile channel snapshots', () => {
  const snapshot = { url: '/static/channel-thumbnails/test.jpg?v=1', captured_at: 1793753090, last_attempt_ok: true };
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    getChannels.mockResolvedValue([{ id: 1, uuid: 'channel-1', name: 'CCTV-13', channel_number: 13,
      channel_group_id: 1, streams: [1] }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ channels: { 'channel-1': snapshot } }) }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows the cached frame and time and plays when the picture is tapped', async () => {
    const { container } = render(<MobileChannels />);
    const card = await screen.findByRole('button', { name: '播放 CCTV-13' });
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', snapshot.url));
    expect(container.querySelector('img')).toHaveAttribute('loading', 'lazy');
    expect(container.querySelector('time')).toHaveAttribute('datetime', new Date(snapshot.captured_at * 1000).toISOString());
    fireEvent.click(container.querySelector('img'));
    expect(showVideo).toHaveBeenCalledWith(expect.stringContaining('/proxy/ts/stream/channel-1'), 'live', {
      name: 'CCTV-13', channelId: 1, streamProfileId: undefined,
    });
    expect(card).toBeEnabled();
  });

  it('keeps selection and playback available when the manifest is unreachable', async () => {
    fetch.mockRejectedValue(new Error('Offline'));
    render(<MobileChannels />);
    fireEvent.click(await screen.findByRole('button', { name: '播放 CCTV-13' }));
    expect(showVideo).toHaveBeenCalledOnce();
    expect(screen.getByText('暂无截图')).toBeInTheDocument();
  });

  it('replaces a broken image with a placeholder and recovers after a new capture', async () => {
    const { container } = render(<MobileChannels />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    fireEvent.error(container.querySelector('img'));
    expect(screen.getByText('暂无截图')).toBeInTheDocument();
    fetch.mockResolvedValue({ ok: true, json: async () => ({ channels: { 'channel-1': {
      ...snapshot, url: '/static/channel-thumbnails/test.jpg?v=2', last_attempt_ok: false,
    } } }) });
    fireEvent.click(screen.getByRole('button', { name: '刷新频道' }));
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', '/static/channel-thumbnails/test.jpg?v=2'));
    expect(container.querySelector('time')).toHaveTextContent('上次截图');
  });
});
